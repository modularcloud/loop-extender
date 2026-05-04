/**
 * Custom module resolve and load hooks.
 * - Intercepts bare specifier "loopx" and "loopx/internal"
 *   and resolves them to the running CLI's package exports.
 * - Forces .js / .ts / .tsx / .jsx files executed as entry points by loopx
 *   to be loaded as ESM, ensuring CommonJS syntax (require, module.exports,
 *   exports.foo) fails at execution time per SPEC 6.3.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

interface ResolveContext {
  conditions: string[];
  importAttributes: Record<string, string>;
  parentURL?: string;
}

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
  format?: string;
}

type NextResolve = (
  specifier: string,
  context: ResolveContext
) => Promise<ResolveResult>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  if (specifier === "loopx" || specifier === "loopx/internal") {
    // Per Spec 2.1 and 3.3: if a directory script has its own node_modules/loopx,
    // standard module resolution applies and the local version takes precedence.
    // Try standard resolution first; fall back to CLI's package only if it fails.
    try {
      return await nextResolve(specifier, context);
    } catch (err: unknown) {
      // Only fall back for module-not-found; re-throw real errors
      // (e.g. corrupted package.json in local node_modules/loopx).
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND"
      ) {
        throw err;
      }
    }

    if (specifier === "loopx") {
      return {
        url: new URL("./index.js", import.meta.url).href,
        shortCircuit: true,
      };
    }
    return {
      url: new URL("./internal.js", import.meta.url).href,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}

interface LoadContext {
  conditions: string[];
  importAttributes: Record<string, string>;
  format?: string | null;
}

interface LoadResult {
  format: string;
  shortCircuit?: boolean;
  source?: string | ArrayBuffer | SharedArrayBuffer;
}

type NextLoad = (
  url: string,
  context: LoadContext
) => Promise<LoadResult>;

const SCRIPT_EXTENSIONS: ReadonlyArray<{ ext: string; loader: "ts" | "tsx" | "jsx" }> = [
  { ext: ".ts", loader: "ts" },
  { ext: ".tsx", loader: "tsx" },
  { ext: ".jsx", loader: "jsx" },
];

/**
 * Force .js / .ts / .tsx / .jsx files in .loopx/ directories to be loaded as
 * ESM. This ensures CommonJS syntax (require, module.exports, exports.foo) is
 * not available per SPEC 6.3 — any reference to those bindings throws a
 * ReferenceError at execution time.
 *
 * For .js: read source directly (no transform needed) and force ESM.
 * For .ts / .tsx / .jsx: type-strip via esbuild WITHOUT a `format` option so
 * esbuild does not auto-wrap the body in a __commonJS() factory (which would
 * provide `module` / `exports` as function parameters and defeat the SPEC 6.3
 * rejection contract). The output is plain JS with TS / JSX stripped; Node
 * then evaluates it as a true ES module, where `module` / `exports` are not
 * in scope.
 *
 * Exclude node_modules/ to avoid breaking CJS dependencies imported by
 * workflow scripts.
 */
export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad
): Promise<LoadResult> {
  if (url.includes("/.loopx/") && !url.includes("/node_modules/")) {
    if (url.endsWith(".js")) {
      const filePath = fileURLToPath(url);
      const source = await readFile(filePath, "utf-8");
      return { format: "module", source, shortCircuit: true };
    }
    for (const { ext, loader } of SCRIPT_EXTENSIONS) {
      if (url.endsWith(ext)) {
        const filePath = fileURLToPath(url);
        const rawSource = await readFile(filePath, "utf-8");
        const result = await esbuild.transform(rawSource, {
          loader,
          // Deliberately NO `format` option: with `format: "esm"` esbuild
          // wraps any module containing CJS-style assignments in a
          // __commonJS factory that exposes `module` / `exports` as
          // function parameters, defeating SPEC 6.3 rejection. With no
          // format, esbuild emits plain transformed JS (types stripped,
          // JSX transformed) with the original CJS references intact;
          // Node then sees them as undeclared bindings under ESM and
          // throws ReferenceError at evaluation time.
          target: "esnext",
          sourcefile: filePath,
          jsx: "transform",
          jsxFactory: "React.createElement",
          jsxFragment: "React.Fragment",
          sourcemap: "inline",
        });
        return {
          format: "module",
          source: result.code,
          shortCircuit: true,
        };
      }
    }
  }

  return nextLoad(url, context);
}
