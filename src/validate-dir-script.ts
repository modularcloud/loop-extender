import { readFileSync, statSync, realpathSync } from "node:fs";
import { join, extname, resolve, relative } from "node:path";
import { SUPPORTED_EXTENSIONS } from "./discovery.js";

export type ValidationCode =
  | "no-pkg"
  | "unreadable"
  | "invalid-json"
  | "invalid-object"
  | "no-main"
  | "bad-main-type"
  | "bad-ext"
  | "escapes"
  | "not-found"
  | "not-file"
  | "symlink-escape"
  | "resolve-failed";

export type DirScriptValidation =
  | { valid: true; mainPath: string; mainExt: string }
  | { valid: false; code: ValidationCode; detail?: string };

export function validateDirScriptCore(
  dirPath: string
): DirScriptValidation {
  const pkgPath = join(dirPath, "package.json");

  let pkgContent: string;
  try {
    pkgContent = readFileSync(pkgPath, "utf-8");
  } catch (err: unknown) {
    try {
      statSync(pkgPath);
      return { valid: false, code: "unreadable" };
    } catch {
      return { valid: false, code: "no-pkg" };
    }
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgContent);
  } catch {
    return { valid: false, code: "invalid-json" };
  }

  if (typeof pkg !== "object" || pkg === null) {
    return { valid: false, code: "invalid-object" };
  }

  const pkgObj = pkg as Record<string, unknown>;

  if (!("main" in pkgObj)) {
    return { valid: false, code: "no-main" };
  }

  if (typeof pkgObj.main !== "string") {
    return { valid: false, code: "bad-main-type" };
  }

  const mainField = pkgObj.main;
  const mainExt = extname(mainField);

  if (!SUPPORTED_EXTENSIONS.has(mainExt)) {
    return { valid: false, code: "bad-ext", detail: mainExt };
  }

  const mainPath = resolve(dirPath, mainField);
  const relPath = relative(dirPath, mainPath);
  if (relPath.startsWith("..")) {
    return { valid: false, code: "escapes" };
  }

  try {
    const mainStat = statSync(mainPath);
    if (!mainStat.isFile()) {
      return { valid: false, code: "not-file", detail: mainField };
    }
  } catch {
    return { valid: false, code: "not-found", detail: mainField };
  }

  try {
    const realMainPath = realpathSync(mainPath);
    const realDirPath = realpathSync(dirPath);
    const realRel = relative(realDirPath, realMainPath);
    if (realRel.startsWith("..")) {
      return { valid: false, code: "symlink-escape" };
    }
  } catch {
    return { valid: false, code: "resolve-failed" };
  }

  return { valid: true, mainPath, mainExt };
}
