import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { isValidRange, satisfies } from "./semver.js";

// Workflow-level loopx version check per SPEC §3.2 (and ADR-0003 §5).
//
// Reads the workflow's own package.json and extracts the loopx range from
// `dependencies` (preferred) or `devDependencies` (fallback). Per SPEC,
// `optionalDependencies.loopx` at the workflow level is intentionally
// ignored — it is only checked at project-root delegation.
//
// Failure modes (all non-blocking at runtime; emit a warning and skip the
// check):
//   - no-package-json:     file doesn't exist → silent (not a warning)
//   - unreadable:          EACCES/EPERM reading the file → warning
//   - invalid-json:        JSON.parse failed → warning
//   - no-loopx-declared:   file parsed but no loopx in dep/devDep → silent
//   - invalid-semver:      range doesn't parse as semver → warning
//   - satisfied:           running version matches → silent
//   - mismatched:          running version doesn't match → warning

export type VersionCheckResult =
  | { kind: "no-package-json" }
  | { kind: "unreadable" }
  | { kind: "invalid-json" }
  | { kind: "no-loopx-declared" }
  | { kind: "invalid-semver"; range: string }
  | { kind: "satisfied" }
  | { kind: "mismatched"; range: string; running: string };

/**
 * Check the workflow's package.json for a loopx version declaration and
 * validate it against the running version.
 */
export function checkWorkflowVersion(
  workflowDir: string,
  runningVersion: string
): VersionCheckResult {
  const pkgPath = join(workflowDir, "package.json");

  if (!existsSync(pkgPath)) {
    return { kind: "no-package-json" };
  }

  try {
    accessSync(pkgPath, constants.R_OK);
  } catch {
    return { kind: "unreadable" };
  }

  let content: string;
  try {
    content = readFileSync(pkgPath, "utf-8");
  } catch {
    return { kind: "unreadable" };
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(content);
  } catch {
    return { kind: "invalid-json" };
  }

  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    return { kind: "invalid-json" };
  }

  const obj = pkg as Record<string, unknown>;
  const entry = extractLoopxValue(obj);
  if (entry === null) {
    return { kind: "no-loopx-declared" };
  }
  // Per SPEC §3.2: any value that is not a valid semver range — including
  // non-string types — is treated as "invalid semver range".
  if (typeof entry.value !== "string") {
    return { kind: "invalid-semver", range: String(entry.value) };
  }
  const range = entry.value;
  if (!isValidRange(range)) {
    return { kind: "invalid-semver", range };
  }

  if (satisfies(runningVersion, range)) {
    return { kind: "satisfied" };
  }
  return { kind: "mismatched", range, running: runningVersion };
}

/**
 * Workflow-level: locate the `loopx` entry in `dependencies` (wins if both
 * are present) then `devDependencies`. Returns the raw value (preserving
 * type so the caller can distinguish a non-string value from a missing
 * declaration). Per SPEC §3.2, `optionalDependencies` is NOT checked at
 * the workflow level.
 */
function extractLoopxValue(
  pkg: Record<string, unknown>
): { value: unknown } | null {
  const deps = pkg.dependencies;
  if (typeof deps === "object" && deps !== null && !Array.isArray(deps)) {
    if (Object.prototype.hasOwnProperty.call(deps, "loopx")) {
      return { value: (deps as Record<string, unknown>).loopx };
    }
  }
  const devDeps = pkg.devDependencies;
  if (
    typeof devDeps === "object" &&
    devDeps !== null &&
    !Array.isArray(devDeps)
  ) {
    if (Object.prototype.hasOwnProperty.call(devDeps, "loopx")) {
      return { value: (devDeps as Record<string, unknown>).loopx };
    }
  }
  return null;
}

/**
 * Format a VersionCheckResult as a stderr warning suitable for the runtime
 * path. The workflow name is included so tests can scope assertions. Returns
 * null if no warning should be emitted (satisfied/no-package-json/no-declared).
 */
export function formatWarning(
  result: VersionCheckResult,
  workflowName: string
): string | null {
  switch (result.kind) {
    case "no-package-json":
    case "no-loopx-declared":
    case "satisfied":
      return null;
    case "unreadable":
      return `Warning: workflow '${workflowName}' package.json is unreadable (permission denied); skipping check`;
    case "invalid-json":
      return `Warning: workflow '${workflowName}' package.json contains invalid JSON; skipping check`;
    case "invalid-semver":
      return `Warning: workflow '${workflowName}' has an invalid semver specifier for loopx in package.json; skipping check`;
    case "mismatched":
      return `Warning: workflow '${workflowName}' requires loopx version ${result.range} but running version ${result.running} does not satisfy that range`;
  }
}
