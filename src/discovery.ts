import { readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { validateDirScriptCore } from "./validate-dir-script.js";

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
  candidateNames: Set<string>;
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
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      if (mode === "run") {
        errors.push(
          "No .loopx/ directory found. Create .loopx/default.ts or specify a script name."
        );
      }
    } else {
      const msg = `Cannot read .loopx/ directory: ${(err as Error).message}`;
      if (mode === "run") {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
    return { scripts: new Map(), candidateNames: new Set(), warnings, errors };
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

  // Check reserved names (iterate unique names, not all candidates)
  for (const [name] of nameGroups) {
    if (RESERVED_NAMES.has(name)) {
      if (mode === "run") {
        errors.push(
          `Script name '${name}' is reserved (used by loopx subcommand)`
        );
      } else {
        warnings.push(
          `Warning: script '${name}' uses a reserved name`
        );
      }
    }
  }

  // Check name restrictions (iterate unique names, not all candidates)
  for (const [name] of nameGroups) {
    if (!NAME_PATTERN.test(name)) {
      if (mode === "run") {
        errors.push(
          `Script name '${name}' is invalid: must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`
        );
      } else {
        warnings.push(
          `Warning: script '${name}' has invalid name`
        );
      }
    }
  }

  // Collect all candidate names (including collisions)
  const candidateNames = new Set<string>(nameGroups.keys());

  // Build final script map
  const scripts = new Map<string, ScriptEntry>();
  if (errors.length === 0) {
    for (const [name, entries] of nameGroups) {
      if (entries.length === 1) {
        scripts.set(name, entries[0]);
      }
    }
  }

  return { scripts, candidateNames, warnings, errors };
}

function validateDirScript(
  dirName: string,
  dirPath: string
): { entry?: ScriptEntry; warning?: string } {
  const result = validateDirScriptCore(dirPath);

  if (result.valid) {
    return {
      entry: {
        name: dirName,
        type: "directory",
        ext: result.mainExt,
        scriptPath: result.mainPath,
        dirPath,
      },
    };
  }

  // In discovery mode: no-pkg and no-main are silent skips
  const warningMap: Record<string, string | null> = {
    "no-pkg": null,
    "unreadable": `Warning: ${dirName}/package.json is unreadable or has permission issues, skipping`,
    "invalid-json": `Warning: ${dirName}/package.json contains invalid JSON, skipping`,
    "invalid-object": `Warning: ${dirName}/package.json is not a valid object, skipping`,
    "no-main": null,
    "bad-main-type": `Warning: ${dirName}/package.json main field is not a string, skipping`,
    "bad-ext": `Warning: ${dirName}/package.json main has unsupported extension '${result.detail}', skipping`,
    "escapes": `Warning: ${dirName}/package.json main escapes directory boundary, skipping`,
    "not-found": `Warning: ${dirName}/package.json main '${result.detail}' not found, skipping`,
    "not-file": `Warning: ${dirName}/package.json main '${result.detail}' is not a file, skipping`,
    "symlink-escape": `Warning: ${dirName}/package.json main resolves outside directory boundary (symlink), skipping`,
    "resolve-failed": `Warning: ${dirName}/package.json main cannot be resolved, skipping`,
  };

  const warning = warningMap[result.code];
  return warning ? { warning } : {};
}
