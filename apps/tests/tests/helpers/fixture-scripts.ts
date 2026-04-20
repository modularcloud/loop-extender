/**
 * Fixture script factory functions.
 * Each function returns the script content string.
 * See TEST-SPEC §2.4 for the full catalog.
 */

// --- Bash fixtures ---

/** Outputs JSON with result field. Only safe for simple string values without JSON-special chars. */
export function emitResult(value: string): string {
  return `#!/bin/bash\nprintf '{"result":"%s"}' '${value}'\n`;
}

/** Outputs JSON with goto field. */
export function emitGoto(target: string): string {
  return `#!/bin/bash\nprintf '{"goto":"%s"}' '${target}'\n`;
}

/** Outputs JSON with stop:true. */
export function emitStop(): string {
  return `#!/bin/bash\nprintf '{"stop":true}'\n`;
}

/** Outputs JSON with both result and goto fields. */
export function emitResultGoto(value: string, target: string): string {
  return `#!/bin/bash\nprintf '{"result":"%s","goto":"%s"}' '${value}' '${target}'\n`;
}

/** Outputs exact bytes with no trailing newline. */
export function emitRaw(text: string): string {
  return `#!/bin/bash\nprintf '%s' '${text}'\n`;
}

/** Outputs exact bytes with trailing newline. */
export function emitRawLn(text: string): string {
  return `#!/bin/bash\nprintf '%s\\n' '${text}'\n`;
}

/** Exits with the specified code. */
export function exitCode(n: number): string {
  return `#!/bin/bash\nexit ${n}\n`;
}

/** Reads stdin, echoes it as result JSON. */
export function catStdin(): string {
  return `#!/bin/bash
INPUT=$(cat)
printf '{"result":"%s"}' "$INPUT"
`;
}

/** Writes msg to stderr, then produces output. */
export function writeStderr(msg: string): string {
  return `#!/bin/bash
echo '${msg}' >&2
printf '{"result":"ok"}'
`;
}

/** Sleeps then exits 0. General-purpose long-running script. */
export function sleepThenExit(seconds: number): string {
  return `#!/bin/bash\nsleep ${seconds}\nexit 0\n`;
}

/** Writes the value of an env var to a marker file using printf. */
export function writeEnvToFile(varname: string, markerPath: string): string {
  return `#!/bin/bash\nprintf '%s' "\$${varname}" > "${markerPath}"\n`;
}

/** Writes $PWD to a marker file using printf. */
export function writeCwdToFile(markerPath: string): string {
  return `#!/bin/bash\nprintf '%s' "$PWD" > "${markerPath}"\n`;
}

/** Writes a literal value to a marker file using printf. */
export function writeValueToFile(value: string, markerPath: string): string {
  return `#!/bin/bash\nprintf '%s' '${value}' > "${markerPath}"\n`;
}

/**
 * Writes PID to marker, "ready" to stderr, then sleeps indefinitely.
 * For signal tests — follows the ready-protocol.
 */
export function signalReadyThenSleep(markerPath: string): string {
  return `#!/bin/bash
printf '%s' "$$" > "${markerPath}"
echo "ready" >&2
sleep 999999
`;
}

/**
 * Traps SIGTERM with a handler that sleeps for delay seconds then exits 0.
 * Writes PID to marker, "ready" to stderr.
 */
export function signalTrapExit(markerPath: string, delay: number): string {
  return `#!/bin/bash
trap 'sleep ${delay}; exit 0' SIGTERM
printf '%s' "$$" > "${markerPath}"
echo "ready" >&2
sleep 999999
`;
}

/**
 * Traps SIGTERM and ignores it (no-op handler).
 * Writes PID to marker, "ready" to stderr, sleeps indefinitely.
 */
export function signalTrapIgnore(markerPath: string): string {
  return `#!/bin/bash
trap '' SIGTERM
printf '%s' "$$" > "${markerPath}"
echo "ready" >&2
sleep 999999
`;
}

/**
 * Traps both SIGINT and SIGTERM, writes which signal was received to reportPath.
 * Writes PID to marker, "ready" to stderr, sleeps (via wait) until signal arrives.
 */
export function signalTrapReport(markerPath: string, reportPath: string): string {
  return `#!/bin/bash
trap 'printf SIGINT > "${reportPath}"; exit 130' INT
trap 'printf SIGTERM > "${reportPath}"; exit 143' TERM
printf '%s' "$$" > "${markerPath}"
echo "ready" >&2
sleep 999999 &
wait
`;
}

/**
 * Spawns a background subprocess, writes both PIDs to marker (one per line),
 * writes "ready" to stderr, then waits.
 */
export function spawnGrandchild(markerPath: string): string {
  return `#!/bin/bash
sleep 3600 &
printf '%s\\n' "$$" > "${markerPath}"
printf '%s\\n' "$!" >> "${markerPath}"
echo "ready" >&2
wait
`;
}

/**
 * Appends "1" to a counter file each invocation, outputs count as result.
 */
export function counter(file: string): string {
  return `#!/bin/bash
printf '1' >> "${file}"
COUNT=$(wc -c < "${file}" | tr -d ' ')
printf '{"result":"%s"}' "$COUNT"
`;
}

// --- TypeScript fixtures ---

/**
 * TS fixture: writes JSON { present, value? } to a marker file.
 * Distinguishes unset from empty string.
 */
export function observeEnv(varname: string, markerPath: string): string {
  return `import { writeFileSync } from "node:fs";
const val = process.env["${varname}"];
const data = val === undefined
  ? { present: false }
  : { present: true, value: val };
writeFileSync("${markerPath}", JSON.stringify(data));
`;
}

/**
 * TS fixture: reads a payload file and writes it to stdout.
 */
export function stdoutWriter(payloadFile: string): string {
  return `import { readFileSync } from "node:fs";
const data = readFileSync("${payloadFile}");
process.stdout.write(data);
`;
}

/**
 * TS fixture: writes process.pid to marker, "ready" to stderr, then blocks.
 */
export function writePidToFile(markerPath: string): string {
  return `import { writeFileSync } from "node:fs";
writeFileSync("${markerPath}", String(process.pid));
process.stderr.write("ready\\n");
setTimeout(() => {}, 999999);
`;
}

/**
 * TS fixture: uses import { output } from "loopx" to emit structured output.
 */
export function tsOutput(fields: Record<string, unknown>): string {
  return `import { output } from "loopx";
output(${JSON.stringify(fields)});
`;
}

/**
 * TS fixture: reads input(), outputs it as result.
 */
export function tsInputEcho(): string {
  return `import { input, output } from "loopx";
const data = await input();
output({ result: data });
`;
}

/**
 * TS fixture: imports from "loopx", outputs success marker.
 */
export function tsImportCheck(): string {
  return `import { output, input } from "loopx";
output({ result: "loopx-import-ok" });
`;
}
