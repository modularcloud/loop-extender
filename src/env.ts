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

export function getGlobalEnvPath(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ||
    join(process.env.HOME || homedir(), ".config");
  return join(xdg, "loopx", "env");
}

export function loadGlobalEnv(): {
  vars: Record<string, string>;
  warnings: string[];
} {
  const envPath = getGlobalEnvPath();

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
  loopxBin: string,
  projectRoot: string
): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    ...globalEnv,
    ...localEnv,
    LOOPX_BIN: loopxBin,
    LOOPX_PROJECT_ROOT: projectRoot,
  };
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

  // Set the new value
  existing[name] = value;

  // Serialize all vars
  const lines = Object.entries(existing)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join("\n");

  writeFileSync(envPath, lines + "\n", "utf-8");
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

  if (Object.keys(vars).length === 0) {
    writeFileSync(envPath, "", "utf-8");
    return;
  }

  const lines = Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join("\n");

  writeFileSync(envPath, lines + "\n", "utf-8");
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
  const { vars } = parseEnvFile(content);

  const sorted = Object.entries(vars).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  for (const [key, value] of sorted) {
    process.stdout.write(`${key}=${value}\n`);
  }
}
