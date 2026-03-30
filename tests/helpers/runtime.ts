import { execSync } from "node:child_process";
import { describe, it } from "vitest";

type Runtime = "node" | "bun";

interface RuntimeInfo {
  runtime: Runtime;
  version: string;
}

function detectRuntimes(): RuntimeInfo[] {
  const runtimes: RuntimeInfo[] = [];

  // Detect Node.js >= 20.6
  try {
    const nodeVersion = execSync("node --version", { stdio: "pipe" })
      .toString()
      .trim()
      .replace(/^v/, "");
    const [major, minor] = nodeVersion.split(".").map(Number);
    if (major > 20 || (major === 20 && minor >= 6)) {
      runtimes.push({ runtime: "node", version: nodeVersion });
    }
  } catch {
    // Node.js not available
  }

  // Detect Bun >= 1.0
  try {
    const bunVersion = execSync("bun --version", { stdio: "pipe" })
      .toString()
      .trim();
    const [major] = bunVersion.split(".").map(Number);
    if (major >= 1) {
      runtimes.push({ runtime: "bun", version: bunVersion });
    }
  } catch {
    // Bun not available
  }

  return runtimes;
}

let cachedRuntimes: RuntimeInfo[] | null = null;

function getAvailableRuntimes(): RuntimeInfo[] {
  if (cachedRuntimes === null) {
    cachedRuntimes = detectRuntimes();
  }
  return cachedRuntimes;
}

/**
 * Test parameterization helper. Runs a test block once per available runtime.
 * Skips if runtime not installed.
 */
export function forEachRuntime(
  fn: (runtime: Runtime, version: string) => void
): void {
  const runtimes = getAvailableRuntimes();

  if (runtimes.length === 0) {
    it.skip("No supported runtimes available", () => {});
    return;
  }

  for (const { runtime, version } of runtimes) {
    describe(`[${runtime} ${version}]`, () => {
      fn(runtime, version);
    });
  }
}

/**
 * Returns the list of detected runtimes.
 */
export function getDetectedRuntimes(): RuntimeInfo[] {
  return getAvailableRuntimes();
}

/**
 * Check if a specific runtime is available.
 */
export function isRuntimeAvailable(runtime: Runtime): boolean {
  return getAvailableRuntimes().some((r) => r.runtime === runtime);
}
