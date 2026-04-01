import {
  readdirSync,
  statSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, extname, basename, resolve, relative } from "node:path";

export const SUPPORTED_EXTENSIONS = new Set([".sh", ".js", ".jsx", ".ts", ".tsx"]);
export const RESERVED_NAMES = new Set(["output", "env", "install", "version"]);
export const NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

export interface ScriptEntry {
  name: string;
  type: "file" | "directory";
  ext: string;
  scriptPath: string;
  dirPath?: string;
}

export interface DiscoveryResult {
  scripts: Map<string, ScriptEntry>;
  warnings: string[];
  errors: string[];
}

export function discoverScripts(
  loopxDir: string,
  mode: "run" | "help"
): DiscoveryResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const candidates: ScriptEntry[] = [];

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(loopxDir);
  } catch {
    if (mode === "run") {
      errors.push(
        "No .loopx/ directory found. Create .loopx/default.ts or specify a script name."
      );
    }
    return { scripts: new Map(), warnings, errors };
  }

  for (const entry of dirEntries) {
    const fullPath = join(loopxDir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      const ext = extname(entry);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      const name = basename(entry, ext);
      candidates.push({ name, type: "file", ext, scriptPath: fullPath });
    } else if (stat.isDirectory()) {
      const result = validateDirScript(entry, fullPath);
      if (result.warning) {
        warnings.push(result.warning);
      }
      if (result.entry) {
        candidates.push(result.entry);
      }
    }
  }

  // Check name collisions
  const nameGroups = new Map<string, ScriptEntry[]>();
  for (const c of candidates) {
    const list = nameGroups.get(c.name) || [];
    list.push(c);
    nameGroups.set(c.name, list);
  }

  for (const [name, entries] of nameGroups) {
    if (entries.length > 1) {
      const fileList = entries
        .map((e) => (e.type === "file" ? `${e.name}${e.ext}` : `${e.name}/`))
        .join(", ");
      if (mode === "run") {
        errors.push(
          `Script name collision: '${name}' has multiple entries: ${fileList}`
        );
      } else {
        warnings.push(
          `Warning: script name collision: '${name}' has multiple entries: ${fileList}`
        );
      }
    }
  }

  // Check reserved names
  for (const c of candidates) {
    if (RESERVED_NAMES.has(c.name)) {
      if (mode === "run") {
        errors.push(
          `Script name '${c.name}' is reserved (used by loopx subcommand)`
        );
      } else {
        warnings.push(
          `Warning: script '${c.name}' uses a reserved name`
        );
      }
    }
  }

  // Check name restrictions
  for (const c of candidates) {
    if (!NAME_PATTERN.test(c.name)) {
      if (mode === "run") {
        errors.push(
          `Script name '${c.name}' is invalid: must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`
        );
      } else {
        warnings.push(
          `Warning: script '${c.name}' has invalid name`
        );
      }
    }
  }

  // Build final script map
  const scripts = new Map<string, ScriptEntry>();
  if (errors.length === 0) {
    for (const [name, entries] of nameGroups) {
      if (entries.length === 1) {
        scripts.set(name, entries[0]);
      }
    }
  }

  return { scripts, warnings, errors };
}

function validateDirScript(
  dirName: string,
  dirPath: string
): { entry?: ScriptEntry; warning?: string } {
  const pkgPath = join(dirPath, "package.json");

  let pkgContent: string;
  try {
    pkgContent = readFileSync(pkgPath, "utf-8");
  } catch (err: unknown) {
    try {
      statSync(pkgPath);
      return {
        warning: `Warning: ${dirName}/package.json is unreadable or has permission issues, skipping`,
      };
    } catch {
      return {};
    }
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgContent);
  } catch {
    return {
      warning: `Warning: ${dirName}/package.json contains invalid JSON, skipping`,
    };
  }

  if (typeof pkg !== "object" || pkg === null) {
    return {
      warning: `Warning: ${dirName}/package.json is not a valid object, skipping`,
    };
  }

  const pkgObj = pkg as Record<string, unknown>;

  if (!("main" in pkgObj)) {
    return {};
  }

  if (typeof pkgObj.main !== "string") {
    return {
      warning: `Warning: ${dirName}/package.json main field is not a string, skipping`,
    };
  }

  const mainField = pkgObj.main;
  const mainExt = extname(mainField);

  if (!SUPPORTED_EXTENSIONS.has(mainExt)) {
    return {
      warning: `Warning: ${dirName}/package.json main has unsupported extension '${mainExt}', skipping`,
    };
  }

  // Check if main escapes directory
  const mainPath = resolve(dirPath, mainField);
  const relPath = relative(dirPath, mainPath);
  if (relPath.startsWith("..")) {
    return {
      warning: `Warning: ${dirName}/package.json main escapes directory boundary, skipping`,
    };
  }

  // Check if main file exists
  try {
    const mainStat = statSync(mainPath);
    if (!mainStat.isFile()) {
      return {
        warning: `Warning: ${dirName}/package.json main '${mainField}' is not a file, skipping`,
      };
    }
  } catch {
    return {
      warning: `Warning: ${dirName}/package.json main '${mainField}' not found, skipping`,
    };
  }

  // Symlink boundary check
  try {
    const realMainPath = realpathSync(mainPath);
    const realDirPath = realpathSync(dirPath);
    const realRel = relative(realDirPath, realMainPath);
    if (realRel.startsWith("..")) {
      return {
        warning: `Warning: ${dirName}/package.json main resolves outside directory boundary (symlink), skipping`,
      };
    }
  } catch {
    return {
      warning: `Warning: ${dirName}/package.json main cannot be resolved, skipping`,
    };
  }

  return {
    entry: {
      name: dirName,
      type: "directory",
      ext: mainExt,
      scriptPath: mainPath,
      dirPath,
    },
  };
}
