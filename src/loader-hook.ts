/**
 * Custom module resolve hook.
 * Intercepts bare specifier "loopx" and "loopx/internal"
 * and resolves them to the running CLI's package exports.
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
  if (specifier === "loopx") {
    return {
      url: new URL("./index.js", import.meta.url).href,
      shortCircuit: true,
    };
  }

  if (specifier === "loopx/internal") {
    return {
      url: new URL("./internal.js", import.meta.url).href,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
