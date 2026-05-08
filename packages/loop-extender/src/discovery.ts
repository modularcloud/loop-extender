import { readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { NAME_PATTERN } from "./target-validation.js";

export const SUPPORTED_EXTENSIONS = new Set([".sh", ".js", ".jsx", ".ts", ".tsx"]);
export { NAME_PATTERN };

export interface ScriptFile {
  name: string; // base name without extension
  ext: string; // e.g., ".sh"
  path: string; // absolute path to the script file
}

export interface Workflow {
  name: string;
  dir: string; // absolute path to the workflow directory
  scripts: Map<string, ScriptFile>; // script name → script file
  // Raw script candidates grouped by base name (used to display collisions
  // in the -h path).
  candidateScripts: Map<string, ScriptFile[]>;
  hasIndex: boolean;
}

export interface DiscoveryResult {
  workflows: Map<string, Workflow>;
  candidateWorkflowNames: Set<string>;
  warnings: string[];
  errors: string[];
}

/**
 * Two-level discovery per SPEC §5.1 (ADR-0003):
 *   - Scan `.loopx/` for subdirectories. Loose files are ignored.
 *   - A subdirectory is a workflow if it contains at least one top-level file
 *     with a supported extension. Empty/non-script subdirs are silently ignored.
 *   - For each workflow, scan its top-level files for scripts (subdirectories
 *     inside a workflow are not scanned).
 *   - Validate workflow names and script names against NAME_PATTERN.
 *   - Detect per-workflow base-name collisions (e.g. check.sh + check.ts).
 *
 * Mode semantics (SPEC §5.2/5.3/5.4):
 *   "run"  — collisions and name-restriction violations in ANY workflow are fatal
 *            errors; the entire run is blocked even if the target is unaffected.
 *   "help" — all issues are reported as non-fatal warnings; valid entries still
 *            returned.
 */
export function discoverScripts(
  loopxDir: string,
  mode: "run" | "help"
): DiscoveryResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const workflows = new Map<string, Workflow>();
  const candidateWorkflowNames = new Set<string>();

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(loopxDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      if (mode === "run") {
        errors.push(
          "No .loopx/ directory found. Invalid project root: create a .loopx/ directory with workflows."
        );
      } else {
        warnings.push("Warning: .loopx/ directory not found");
      }
    } else {
      const msg = `Cannot read .loopx/ directory: ${(err as Error).message}`;
      if (mode === "run") {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
    return { workflows, candidateWorkflowNames, warnings, errors };
  }

  for (const entry of dirEntries) {
    const wfPath = join(loopxDir, entry);
    let wfStat;
    try {
      wfStat = statSync(wfPath);
    } catch {
      continue;
    }

    // Only subdirectories are workflow candidates. Loose files at .loopx/ root
    // are silently ignored per SPEC §5.1.
    if (!wfStat.isDirectory()) continue;

    const workflowName = entry;

    // Scan top-level entries for script files.
    let innerEntries: string[];
    try {
      innerEntries = readdirSync(wfPath);
    } catch {
      // Unreadable workflow directory: skip silently (not a workflow we can
      // evaluate). Not an error — the workflow may be in use by something else.
      continue;
    }

    const candidateScripts = new Map<string, ScriptFile[]>();
    for (const fileEntry of innerEntries) {
      const filePath = join(wfPath, fileEntry);
      let fileStat;
      try {
        fileStat = statSync(filePath);
      } catch {
        continue;
      }
      if (!fileStat.isFile()) continue;

      const ext = extname(fileEntry);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const scriptName = basename(fileEntry, ext);
      const script: ScriptFile = { name: scriptName, ext, path: filePath };
      const existing = candidateScripts.get(scriptName);
      if (existing) {
        existing.push(script);
      } else {
        candidateScripts.set(scriptName, [script]);
      }
    }

    if (candidateScripts.size === 0) {
      // Not a workflow (no supported script files).
      continue;
    }

    candidateWorkflowNames.add(workflowName);

    // Validate workflow name
    if (!NAME_PATTERN.test(workflowName)) {
      const msg = `Workflow name '${workflowName}' is invalid: must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`;
      if (mode === "run") {
        errors.push(msg);
      } else {
        warnings.push(`Warning: ${msg}`);
      }
      // Don't add this workflow to the final map in run mode; in help mode
      // we still surface it so users can see the shape of .loopx/.
      if (mode === "run") continue;
    }

    // Validate script names within this workflow
    for (const [scriptName] of candidateScripts) {
      if (!NAME_PATTERN.test(scriptName)) {
        const msg = `Workflow '${workflowName}' contains script '${scriptName}' with invalid name: must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`;
        if (mode === "run") {
          errors.push(msg);
        } else {
          warnings.push(`Warning: ${msg}`);
        }
      }
    }

    // Detect per-workflow base-name collisions
    for (const [scriptName, entries] of candidateScripts) {
      if (entries.length > 1) {
        const fileList = entries.map((e) => `${e.name}${e.ext}`).join(", ");
        const msg = `Script name collision in workflow '${workflowName}': '${scriptName}' has multiple files: ${fileList}`;
        if (mode === "run") {
          errors.push(msg);
        } else {
          warnings.push(`Warning: ${msg}`);
        }
      }
    }

    // Build the final script map (only include non-collision, valid-name entries)
    const scripts = new Map<string, ScriptFile>();
    for (const [scriptName, entries] of candidateScripts) {
      if (entries.length === 1 && NAME_PATTERN.test(scriptName)) {
        scripts.set(scriptName, entries[0]);
      }
    }

    workflows.set(workflowName, {
      name: workflowName,
      dir: wfPath,
      scripts,
      candidateScripts,
      hasIndex: candidateScripts.has("index"),
    });
  }

  return { workflows, candidateWorkflowNames, warnings, errors };
}

/**
 * Lightweight structural check: is the given path a workflow by structure?
 * (Directory containing at least one top-level file with a supported extension.)
 *
 * Follows symlinks (via statSync). Used by install for collision checks per
 * SPEC §10.5. Does not validate names or collisions — only structure.
 */
export function isWorkflowByStructure(path: string): boolean {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;

  let entries;
  try {
    entries = readdirSync(path);
  } catch {
    return false;
  }

  for (const entry of entries) {
    const full = join(path, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry))) {
      return true;
    }
  }
  return false;
}
