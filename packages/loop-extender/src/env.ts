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

/**
 * Resolve the global loopx env file path from `XDG_CONFIG_HOME` (with `HOME`
 * fallback). Reads `process.env` by default. When `envSnapshot` is provided
 * (the eager `runPromise()` path per SPEC §9.2), the snapshot's
 * `XDG_CONFIG_HOME` / `HOME` are consulted instead so the path is pinned to
 * the values present at the call site rather than reflecting later mutations.
 */
export function getGlobalEnvPath(
  envSnapshot?: Record<string, string>
): string {
  const env = envSnapshot ?? (process.env as Record<string, string>);
  const xdg = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(xdg, "loopx", "env");
}

/**
 * Load and parse the global loopx env file. When `envPath` is supplied
 * (the eager `runPromise()` path per SPEC §9.2) it is used verbatim; otherwise
 * the path is resolved lazily from the live `process.env`.
 */
export function loadGlobalEnv(envPath?: string): {
  vars: Record<string, string>;
  warnings: string[];
} {
  const path = envPath ?? getGlobalEnvPath();

  if (!existsSync(path)) {
    return { vars: {}, warnings: [] };
  }

  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`Global env file is unreadable: ${path}`);
  }

  const content = readFileSync(path, "utf-8");
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
  inheritedEnv?: Record<string, string>
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
  //
  // When `inheritedEnv` is supplied (eager runPromise path per SPEC §9.2) we
  // use that snapshot in place of the live `process.env`. Otherwise we read
  // `process.env` lazily (SPEC §9.1 contract for run() / CLI).
  return {
    ...(inheritedEnv ?? (process.env as Record<string, string>)),
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
  const { vars } = parseEnvFile(content);

  const sorted = Object.entries(vars).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  for (const [key, value] of sorted) {
    process.stdout.write(`${key}=${value}\n`);
  }
}
