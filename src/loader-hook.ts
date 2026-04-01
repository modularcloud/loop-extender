/**
 * Custom module resolve and load hooks.
 * - Intercepts bare specifier "loopx" and "loopx/internal"
 *   and resolves them to the running CLI's package exports.
 * - Forces .js files executed as entry points by loopx to be loaded as ESM,
 *   ensuring CommonJS require() fails per Spec 6.3.
 */

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
    } catch {
      // No local node_modules/loopx found — provide the CLI's own package.
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

/**
 * Force .js files in .loopx/ directories to be loaded as ESM.
 * This ensures CommonJS require() is not available (Spec 6.3).
 */
export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad
): Promise<LoadResult> {
  // For .js files in .loopx/: read source directly and force ESM.
  // Exclude node_modules/ to avoid breaking CJS dependencies in directory scripts.
  if (url.endsWith(".js") && url.includes("/.loopx/") && !url.includes("/node_modules/")) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const filePath = fileURLToPath(url);
    const source = await readFile(filePath, "utf-8");
    return { format: "module", source, shortCircuit: true };
  }

  return nextLoad(url, context);
}
