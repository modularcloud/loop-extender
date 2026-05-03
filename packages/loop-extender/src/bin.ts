#!/usr/bin/env node

import {
  readFileSync,
  realpathSync,
  existsSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { discoverScripts } from "./discovery.js";
import { runLoop, type LoopStartingTarget } from "./loop.js";
import {
  loadGlobalEnv,
  loadLocalEnv,
  mergeEnv,
  envSet,
  envRemove,
  envList,
} from "./env.js";
import { installCommand } from "./install.js";
import { parseTarget } from "./target-validation.js";
import { getLoopxBin, ensureLoopxPackageJson } from "./bin-path.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  // Prefer the package.json adjacent to the entry script as seen by Node via
  // `process.argv[1]`. This preserves any symlink-style install layouts (e.g.
  // `node_modules/loopx/bin.js` that is itself a symlink): under delegation
  // the delegated-to binary's directory holds the real package.json with its
  // own version, which is what workflow-level version checks must compare
  // against (SPEC §3.2 "LOOPX_BIN contains the resolved realpath of the
  // effective binary" + ADR-0003 §5 runtime validation semantics).
  const candidates: string[] = [];
  if (process.argv[1]) {
    const argvDir = dirname(process.argv[1]);
    candidates.push(resolve(argvDir, "package.json"));
    candidates.push(resolve(argvDir, "..", "package.json"));
  }
  candidates.push(resolve(__dirname, "package.json"));
  candidates.push(resolve(__dirname, "..", "package.json"));
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}

// --- CLI Delegation (SPEC §3.2 post-ADR-0003) ---
//
// Project-root-only delegation: check cwd's package.json for a declared
// `loopx` dependency, then check node_modules/.bin/loopx. No ancestor
// traversal.

interface DelegationResult {
  shouldDelegate: boolean;
  binPath: string | null;
  warnings: string[];
}

function checkDelegation(cwd: string): DelegationResult {
  const warnings: string[] = [];
  const pkgPath = join(cwd, "package.json");
  const localBin = join(cwd, "node_modules", ".bin", "loopx");

  if (!existsSync(pkgPath)) {
    return { shouldDelegate: false, binPath: null, warnings };
  }

  try {
    accessSync(pkgPath, fsConstants.R_OK);
  } catch {
    warnings.push(
      `Warning: project-root package.json is unreadable; skipping delegation`
    );
    return { shouldDelegate: false, binPath: null, warnings };
  }

  let pkgContent: string;
  try {
    pkgContent = readFileSync(pkgPath, "utf-8");
  } catch {
    warnings.push(
      `Warning: project-root package.json is unreadable; skipping delegation`
    );
    return { shouldDelegate: false, binPath: null, warnings };
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgContent);
  } catch {
    warnings.push(
      `Warning: project-root package.json contains invalid JSON; skipping delegation`
    );
    return { shouldDelegate: false, binPath: null, warnings };
  }

  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    warnings.push(
      `Warning: project-root package.json is not a valid object; skipping delegation`
    );
    return { shouldDelegate: false, binPath: null, warnings };
  }

  const obj = pkg as Record<string, unknown>;
  const isDeclared =
    hasLoopxDep(obj.dependencies) ||
    hasLoopxDep(obj.devDependencies) ||
    hasLoopxDep(obj.optionalDependencies);

  if (!isDeclared) {
    // Not declared — no delegation even if node_modules/.bin/loopx exists.
    return { shouldDelegate: false, binPath: null, warnings };
  }

  if (!existsSync(localBin)) {
    warnings.push(
      `Warning: project-root package.json declares loopx as a dependency but node_modules/.bin/loopx does not exist; skipping delegation (run 'npm install' to restore)`
    );
    return { shouldDelegate: false, binPath: null, warnings };
  }

  return { shouldDelegate: true, binPath: localBin, warnings };
}

function hasLoopxDep(deps: unknown): boolean {
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    return false;
  }
  const v = (deps as Record<string, unknown>).loopx;
  return typeof v === "string";
}

// --- Top-level Help ---
function printTopLevelHelp(): void {
  console.log(`Usage: loopx <command> [options]

Commands:
  run <workflow>[:<script>]   Run a loopx workflow (and optional script)
  version                     Print the loopx version
  output                      Emit structured output (for bash scripts)
  env                         Manage global environment variables
  install <source>            Install workflows from a git repo or tarball

Options:
  -h, --help          Print this help message

Run 'loopx run -h' to see run options and available workflows.`);
}

// --- Run Help (with discovery) ---
function printRunHelp(loopxDir: string): void {
  console.log(`Usage: loopx run [options] <workflow>[:<script>]

Options:
  -n <count>    Maximum number of loop iterations
  -e <path>     Path to a local env file
  -h, --help    Print this help message`);

  const discovery = discoverScripts(loopxDir, "help");

  for (const w of discovery.warnings) {
    process.stderr.write(w + "\n");
  }

  if (discovery.workflows.size > 0) {
    console.log("\nAvailable workflows:");
    const wfNames = Array.from(discovery.workflows.keys()).sort();
    for (const wfName of wfNames) {
      const wf = discovery.workflows.get(wfName)!;
      console.log(`  ${wf.name}`);
      // List every candidate script (including invalid-named / colliding)
      // so run-help surfaces validation warnings in a user-visible form.
      // The `index` script is annotated as the default entry point, so the
      // annotation appears *after* the script name in the same line.
      const allNames = Array.from(wf.candidateScripts.keys()).sort();
      for (const scriptName of allNames) {
        const files = wf.candidateScripts.get(scriptName)!;
        const isDefault = scriptName === "index" && wf.hasIndex;
        const defaultNote = isDefault ? " — default entry point" : "";
        if (files.length > 1) {
          const list = files.map((f) => `${f.name}${f.ext}`).join(", ");
          console.log(
            `    ${scriptName} (collision: ${list})${defaultNote}`
          );
        } else {
          const script = files[0];
          console.log(`    ${scriptName} (${script.ext})${defaultNote}`);
        }
      }
    }
  }
}

// --- Install Help ---
function printInstallHelp(): void {
  console.log(`Usage: loopx install [options] <source>

Sources:
  org/repo                    GitHub shorthand (expanded to https://github.com/org/repo.git)
  https://github.com/...      Git URL
  https://.../archive.tar.gz  Tarball URL

Options:
  -w <name>, --workflow <name>   Install only the named workflow (multi-workflow source)
  -y                             Override version mismatch and workflow collision checks
  --no-install                   Skip auto-install of workflow dependencies (Spec 10.10)
  -h, --help                     Print this help message`);
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
    if (subArgs.length > 3) {
      process.stderr.write(
        `Error: loopx env set: unexpected extra positional '${subArgs[3]}'\n`
      );
      process.exit(1);
    }
    envSet(subArgs[1], subArgs[2]);
  } else if (action === "remove") {
    if (subArgs.length < 2) {
      process.stderr.write("Error: loopx env remove requires <name>\n");
      process.exit(1);
    }
    if (subArgs.length > 2) {
      process.stderr.write(
        `Error: loopx env remove: unexpected extra positional '${subArgs[2]}'\n`
      );
      process.exit(1);
    }
    envRemove(subArgs[1]);
  } else if (action === "list") {
    if (subArgs.length > 1) {
      process.stderr.write(
        `Error: loopx env list: unexpected extra positional '${subArgs[1]}'\n`
      );
      process.exit(1);
    }
    envList();
  } else {
    process.stderr.write(
      `Error: unknown env subcommand '${action}'. Use set, remove, or list.\n`
    );
    process.exit(1);
  }
}

// --- Install Subcommand Parsing ---
interface InstallArgs {
  help: boolean;
  selectedWorkflow?: string | null;
  override: boolean;
  noInstall: boolean;
  source?: string;
}

function parseInstallArgs(argv: string[]): InstallArgs {
  // Short-circuit: `-h` / `--help` anywhere ignores all validation.
  if (argv.includes("-h") || argv.includes("--help")) {
    return { help: true, override: false, noInstall: false };
  }

  const result: InstallArgs = { help: false, override: false, noInstall: false };
  let sawW = false;
  let sawY = false;
  let sawNoInstall = false;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-w" || arg === "--workflow") {
      if (sawW) {
        process.stderr.write(`Error: duplicate ${arg} flag\n`);
        process.exit(1);
      }
      sawW = true;
      i++;
      if (i >= argv.length) {
        process.stderr.write(`Error: ${arg} requires a value\n`);
        process.exit(1);
      }
      result.selectedWorkflow = argv[i];
    } else if (arg === "-y") {
      if (sawY) {
        process.stderr.write(`Error: duplicate -y flag\n`);
        process.exit(1);
      }
      sawY = true;
      result.override = true;
    } else if (arg === "--no-install") {
      if (sawNoInstall) {
        process.stderr.write(`Error: duplicate --no-install flag\n`);
        process.exit(1);
      }
      sawNoInstall = true;
      result.noInstall = true;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Error: unknown install flag '${arg}'\n`);
      process.exit(1);
    } else {
      if (result.source !== undefined) {
        process.stderr.write(
          `Error: multiple sources not allowed ('${result.source}' then '${arg}')\n`
        );
        process.exit(1);
      }
      result.source = arg;
    }
    i++;
  }

  return result;
}

// --- Run Subcommand Parsing ---
interface RunArgs {
  help: boolean;
  maxIterations?: number;
  envFile?: string;
  target?: string;
}

function parseRunArgs(argv: string[]): RunArgs {
  if (argv.includes("-h") || argv.includes("--help")) {
    return { help: true };
  }

  const result: RunArgs = { help: false };
  let i = 0;
  let sawN = false;
  let sawE = false;

  while (i < argv.length) {
    const arg = argv[i];

    // SPEC §4.1: `--` is rejected wherever it appears. The rejection cites
    // `--` as the offending token — including when `--` would otherwise be
    // consumed as the operand of `-n` or `-e` (covered by the operand-slot
    // checks below before they read `argv[i]` as a value).
    if (arg === "--") {
      process.stderr.write(
        "Error: unrecognized token '--' (loopx run does not accept '--' as an end-of-options marker)\n"
      );
      process.exit(1);
    }

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
      // SPEC §4.1: `--` in the `-n` operand slot is rejected as `--`
      // itself, not as a non-integer operand value.
      if (val === "--") {
        process.stderr.write(
          "Error: unrecognized token '--' (loopx run does not accept '--' as an end-of-options marker)\n"
        );
        process.exit(1);
      }
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
      const val = argv[i];
      // SPEC §4.1: `--` in the `-e` operand slot is rejected as `--`
      // itself, not loaded as the env-file path.
      if (val === "--") {
        process.stderr.write(
          "Error: unrecognized token '--' (loopx run does not accept '--' as an end-of-options marker)\n"
        );
        process.exit(1);
      }
      result.envFile = val;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`Error: unknown flag '${arg}'\n`);
      process.exit(1);
    } else {
      if (result.target) {
        process.stderr.write(`Error: unexpected argument '${arg}'\n`);
        process.exit(1);
      }
      result.target = arg;
    }
    i++;
  }

  return result;
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  // Delegation: project-root only (SPEC §3.2 post-ADR-0003).
  if (process.env.LOOPX_DELEGATED === undefined) {
    const delegation = checkDelegation(cwd);
    for (const w of delegation.warnings) {
      process.stderr.write(w + "\n");
    }
    if (delegation.shouldDelegate && delegation.binPath) {
      const localBinRealpath = realpathSync(delegation.binPath);
      const result = spawnSync(delegation.binPath, process.argv.slice(2), {
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

  const argv = process.argv.slice(2);
  const loopxDir = join(cwd, ".loopx");
  const loopxBin = getLoopxBin();

  if (argv.length === 0) {
    printTopLevelHelp();
    process.exit(0);
  }

  const firstArg = argv[0];

  if (firstArg === "-h" || firstArg === "--help") {
    printTopLevelHelp();
    process.exit(0);
  }

  const SUBCOMMANDS = ["run", "version", "output", "env", "install"];
  if (!SUBCOMMANDS.includes(firstArg)) {
    process.stderr.write(
      `Error: unknown command '${firstArg}'. Run 'loopx -h' for usage.\n`
    );
    process.exit(1);
  }

  if (firstArg === "version") {
    // SPEC §4.3 defines `loopx version` as a no-argument subcommand; SPEC §11
    // documents top-level / run / install help forms only — there is no
    // version-scoped help. Per SPEC §12's non-exhaustive usage-error list and
    // the consistent grammar pattern (`loopx run ralph bar` is a usage error),
    // any extra positional after `version` — including `--help` / `-h` — is a
    // usage error. The version short-circuit must not fire when extra args
    // are present (covers T-CLI-01a / T-CLI-01b).
    if (argv.length > 1) {
      const extra = argv[1];
      process.stderr.write(
        `Error: loopx version takes no arguments (got '${extra}'). Run 'loopx -h' for usage.\n`
      );
      process.exit(1);
    }
    console.log(getVersion());
    process.exit(0);
  }

  if (firstArg === "output") {
    handleOutputSubcommand(argv.slice(1));
    process.exit(0);
  }

  if (firstArg === "env") {
    handleEnvSubcommand(argv.slice(1));
    process.exit(0);
  }

  if (firstArg === "install") {
    const installArgs = parseInstallArgs(argv.slice(1));
    if (installArgs.help) {
      printInstallHelp();
      process.exit(0);
    }
    if (!installArgs.source) {
      process.stderr.write(
        "Error: loopx install requires a <source> argument. Run 'loopx install -h' for usage.\n"
      );
      process.exit(1);
    }
    await installCommand({
      source: installArgs.source,
      cwd,
      selectedWorkflow: installArgs.selectedWorkflow ?? null,
      override: installArgs.override,
      noInstall: installArgs.noInstall,
      runningVersion: getVersion(),
    });
    process.exit(0);
  }

  // --- run subcommand ---
  const runArgv = argv.slice(1);
  const runArgs = parseRunArgs(runArgv);

  if (runArgs.help) {
    printRunHelp(loopxDir);
    process.exit(0);
  }

  // Distinguish "no target provided" (usage error, no discovery) from
  // "empty target string provided" (invalid target, rejected after discovery
  // per SPEC §4.1 and §12).
  if (runArgs.target === undefined) {
    process.stderr.write(
      "Error: loopx run requires a <workflow>[:<script>]. Run 'loopx run -h' for usage.\n"
    );
    process.exit(1);
  }

  // SPEC §7.3 — install pre-iteration signal handlers BEFORE any pre-iteration
  // step (discovery, env-file loading, target resolution, tmpdir creation).
  // A signal observed by these handlers wins over non-signal pre-iteration
  // failures: every pre-iteration failure site below checks `receivedSignal`
  // first and exits via `exitWithSignal()` so the signal exit code (128+N) is
  // surfaced and the displaced failure error is not.
  const ac = new AbortController();
  let receivedSignal: NodeJS.Signals | null = null;

  function exitWithSignal(): never {
    const sigNum =
      constants.signals[receivedSignal as keyof typeof constants.signals] ?? 15;
    process.exit(128 + sigNum);
  }

  // SPEC §7.2 first-observed-wins: a second signal arriving after the first
  // (e.g. SIGTERM during cleanup of a prior SIGINT) does not displace the
  // first signal's exit code. The AbortController is already aborted on the
  // second call (no-op), so we still propagate but leave `receivedSignal`
  // anchored at the first observation.
  const signalHandler = (sig: NodeJS.Signals) => {
    if (receivedSignal === null) {
      receivedSignal = sig;
    }
    ac.abort(sig);
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  // TEST-SPEC §1.4 — pre-iteration sentinel seam. Emit a marker line on
  // stderr after handler installation but before any pre-iteration step so a
  // parent harness can deterministically synchronize signal delivery into the
  // pre-iteration window (T-SIG-20..T-SIG-31). After emission, hold the
  // pre-iteration window open with a bounded sleep so the harness has a
  // deterministic interval to deliver the signal before pre-iteration
  // proceeds — without this, fast pre-iteration paths (small `.loopx/`,
  // valid targets) finish before the signal arrives, defeating the
  // signal-wins precedence assertion. Gated on NODE_ENV=test AND
  // LOOPX_TEST_PREITERATION_SENTINEL=1 so production behavior is
  // unaffected.
  if (
    process.env.NODE_ENV === "test" &&
    process.env.LOOPX_TEST_PREITERATION_SENTINEL
  ) {
    process.stderr.write("LOOPX_PREITERATION_READY\n");
    await new Promise<void>((r) => setTimeout(r, 300));
  }

  // Discovery (global validation per SPEC §5.4).
  const discovery = discoverScripts(loopxDir, "run");
  if (receivedSignal) exitWithSignal();
  for (const w of discovery.warnings) {
    process.stderr.write(w + "\n");
  }
  if (discovery.errors.length > 0) {
    if (receivedSignal) exitWithSignal();
    for (const err of discovery.errors) {
      process.stderr.write(`Error: ${err}\n`);
    }
    process.exit(1);
  }

  if (receivedSignal) exitWithSignal();
  ensureLoopxPackageJson(loopxDir);

  let globalEnv: Record<string, string> = {};
  let localEnv: Record<string, string> = {};

  try {
    const globalResult = loadGlobalEnv();
    globalEnv = globalResult.vars;
    for (const w of globalResult.warnings) {
      process.stderr.write(`Warning: ${w}\n`);
    }
  } catch (err: unknown) {
    if (receivedSignal) exitWithSignal();
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  if (runArgs.envFile) {
    try {
      const envFilePath = resolve(cwd, runArgs.envFile);
      const localResult = loadLocalEnv(envFilePath);
      localEnv = localResult.vars;
      for (const w of localResult.warnings) {
        process.stderr.write(`Warning: ${w}\n`);
      }
    } catch (err: unknown) {
      if (receivedSignal) exitWithSignal();
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    }
  }

  const mergedEnv = mergeEnv(globalEnv, localEnv);

  if (receivedSignal) exitWithSignal();

  // Target resolution
  const parsed = parseTarget(runArgs.target);
  if (!parsed.ok) {
    if (receivedSignal) exitWithSignal();
    process.stderr.write(`Error: ${parsed.error}\n`);
    process.exit(1);
  }

  const workflow = discovery.workflows.get(parsed.workflow);
  if (!workflow) {
    if (receivedSignal) exitWithSignal();
    process.stderr.write(
      `Error: workflow '${parsed.workflow}' not found in .loopx/\n`
    );
    process.exit(1);
  }

  let scriptName: string;
  if (parsed.script === null) {
    if (!workflow.hasIndex || !workflow.scripts.has("index")) {
      if (receivedSignal) exitWithSignal();
      process.stderr.write(
        `Error: workflow '${parsed.workflow}' has no default entry point ('index' script)\n`
      );
      process.exit(1);
    }
    scriptName = "index";
  } else {
    scriptName = parsed.script;
  }

  const scriptFile = workflow.scripts.get(scriptName);
  if (!scriptFile) {
    if (receivedSignal) exitWithSignal();
    process.stderr.write(
      `Error: script '${scriptName}' not found in workflow '${parsed.workflow}'\n`
    );
    process.exit(1);
  }

  // -n 0: validate then exit (SPEC §3.2 — no workflow-level version check).
  if (runArgs.maxIterations === 0) {
    if (receivedSignal) exitWithSignal();
    process.exit(0);
  }

  // SPEC §7.3 — final pre-iteration signal check before iteration begins.
  // Covers T-SIG-31 (fully valid pre-iteration with signal observed by the
  // installed handler — the run would otherwise have proceeded).
  if (receivedSignal) exitWithSignal();

  const starting: LoopStartingTarget = { workflow, script: scriptFile };

  try {
    const loop = runLoop(starting, discovery.workflows, {
      maxIterations: runArgs.maxIterations,
      env: mergedEnv,
      projectRoot: cwd,
      loopxBin,
      runningVersion: getVersion(),
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
