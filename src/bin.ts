#!/usr/bin/env node

/**
 * loopx CLI entry point.
 *
 * This is the main binary invoked as `loopx [options] [script-name]`.
 * Full CLI implementation will be built incrementally across phases.
 */

const args = process.argv.slice(2);

// Help flag takes precedence over everything
if (args.includes("-h") || args.includes("--help")) {
  printHelp();
  process.exit(0);
}

// Subcommands
const subcommand = args[0];

if (subcommand === "version") {
  // Read version from package.json
  // For now, print the version directly
  console.log("0.1.0");
  process.exit(0);
}

if (subcommand === "output") {
  handleOutputSubcommand(args.slice(1));
  process.exit(0);
}

if (subcommand === "env") {
  console.error("loopx env: not yet implemented");
  process.exit(1);
}

if (subcommand === "install") {
  console.error("loopx install: not yet implemented");
  process.exit(1);
}

// Run mode — requires .loopx/ directory
console.error("loopx run: not yet implemented");
process.exit(1);

function printHelp(): void {
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
}

function handleOutputSubcommand(flags: string[]): void {
  if (flags.length === 0) {
    console.error("loopx output: at least one flag (--result, --goto, --stop) is required");
    process.exit(1);
  }

  const output: Record<string, unknown> = {};
  let i = 0;

  while (i < flags.length) {
    const flag = flags[i];
    if (flag === "--result") {
      i++;
      if (i >= flags.length) {
        console.error("loopx output: --result requires a value");
        process.exit(1);
      }
      output.result = flags[i];
    } else if (flag === "--goto") {
      i++;
      if (i >= flags.length) {
        console.error("loopx output: --goto requires a value");
        process.exit(1);
      }
      output.goto = flags[i];
    } else if (flag === "--stop") {
      output.stop = true;
    } else {
      console.error(`loopx output: unknown flag: ${flag}`);
      process.exit(1);
    }
    i++;
  }

  if (Object.keys(output).length === 0) {
    console.error("loopx output: at least one flag (--result, --goto, --stop) is required");
    process.exit(1);
  }

  console.log(JSON.stringify(output));
}
