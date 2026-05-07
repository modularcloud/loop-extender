import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  accessSync,
  constants,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parseEnvFile, KEY_PATTERN } from "./parsers/parse-env.js";

export function getGlobalEnvPath(
  baseEnv: Record<string, string | undefined> = process.env
): string {
  const xdg =
    baseEnv.XDG_CONFIG_HOME ||
    join(baseEnv.HOME || homedir(), ".config");
  return join(xdg, "loopx", "env");
}

export function loadGlobalEnv(
  baseEnv: Record<string, string | undefined> = process.env
): {
  vars: Record<string, string>;
  warnings: string[];
} {
  const envPath = getGlobalEnvPath(baseEnv);

  if (!existsSync(envPath)) {
    return { vars: {}, warnings: [] };
  }

  try {
    accessSync(envPath, constants.R_OK);
  } catch {
    throw new Error(`Global env file is unreadable: ${envPath}`);
  }

  const content = readFileSync(envPath, "utf-8");
  return parseEnvFile(content);
}

export function loadLocalEnv(path: string): {
  vars: Record<string, string>;
  warnings: string[];
} {
  if (!existsSync(path)) {
    throw new Error(`Env file not found: ${path}`);
  }

  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`Env file is unreadable: ${path}`);
  }

  const content = readFileSync(path, "utf-8");
  return parseEnvFile(content);
}

export function mergeEnv(
  globalEnv: Record<string, string>,
  localEnv: Record<string, string>,
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  // Per SPEC §8.3 precedence (highest wins):
  //   loopx-injected (LOOPX_BIN / LOOPX_PROJECT_ROOT / LOOPX_WORKFLOW)
  //   > local env file (-e)
  //   > global loopx env
  //   > inherited system environment
  //
  // The loopx-injected variables are layered on top of this merged base in
  // execution.ts, since they depend on per-script context (workflow name).
  // LOOPX_DELEGATED is *not* scrubbed — if it was inherited from a parent
  // loopx invocation, it passes through unchanged (SPEC §4.7 / TEST-SPEC
  // T-ENV-24a).
  return {
    ...(baseEnv as Record<string, string>),
    ...globalEnv,
    ...localEnv,
  };
}

function writeEnvFile(vars: Record<string, string>, path: string): void {
  if (Object.keys(vars).length === 0) {
    writeFileSync(path, "", "utf-8");
    return;
  }
  const lines = Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join("\n");
  writeFileSync(path, lines + "\n", "utf-8");
}

// --- Subcommand helpers ---

export function envSet(name: string, value: string): void {
  if (!KEY_PATTERN.test(name)) {
    process.stderr.write(
      `Error: invalid variable name '${name}': must match [A-Za-z_][A-Za-z0-9_]*\n`
    );
    process.exit(1);
  }

  if (value.includes("\n") || value.includes("\r")) {
    process.stderr.write(
      `Error: variable value cannot contain newline or carriage return characters\n`
    );
    process.exit(1);
  }

  const envPath = getGlobalEnvPath();
  const dir = dirname(envPath);
  mkdirSync(dir, { recursive: true });

  // Read existing file
  let existing: Record<string, string> = {};
  if (existsSync(envPath)) {
    try {
      accessSync(envPath, constants.R_OK);
      const content = readFileSync(envPath, "utf-8");
      existing = parseEnvFile(content).vars;
    } catch {
      process.stderr.write(`Error: cannot read env file: ${envPath}\n`);
      process.exit(1);
    }
  }

  existing[name] = value;
  writeEnvFile(existing, envPath);
}

export function envRemove(name: string): void {
  const envPath = getGlobalEnvPath();

  if (!existsSync(envPath)) {
    return; // silent no-op
  }

  try {
    accessSync(envPath, constants.R_OK);
  } catch {
    process.stderr.write(`Error: cannot read env file: ${envPath}\n`);
    process.exit(1);
  }

  const content = readFileSync(envPath, "utf-8");
  const { vars } = parseEnvFile(content);

  delete vars[name];
  writeEnvFile(vars, envPath);
}

export function envList(): void {
  const envPath = getGlobalEnvPath();

  if (!existsSync(envPath)) {
    return; // no output
  }

  try {
    accessSync(envPath, constants.R_OK);
  } catch {
    process.stderr.write(`Error: cannot read env file: ${envPath}\n`);
    process.exit(1);
  }

  const content = readFileSync(envPath, "utf-8");
  const { vars, warnings } = parseEnvFile(content);
  for (const warning of warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }

  const sorted = Object.entries(vars).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  for (const [key, value] of sorted) {
    process.stdout.write(`${key}=${value}\n`);
  }
}
