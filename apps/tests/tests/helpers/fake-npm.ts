import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";

/**
 * Test helper for SPEC §10.10 auto-install (TEST-SPEC §2.3 `withFakeNpm`).
 *
 * Creates a throw-away directory containing a shim executable named `npm`
 * and prepends that directory to `PATH` for the duration of `fn`. The shim
 * records every invocation to a log file so tests can assert which
 * workflows `npm install` was invoked for, in what order, and with what
 * environment.
 */

export interface FakeNpmOptions {
  exitCode?: number;
  exitCodeByWorkflow?: Record<string, number>;
  spawnFailure?: boolean;
  stdout?: string;
  stderr?: string;
  sleepSeconds?: number;
  sleepByWorkflow?: Record<string, number>;
  trapSignals?: Array<"TERM" | "INT">;
  spawnGrandchild?: boolean;
  grandchildPidFile?: string;
  pidFile?: string;
  createFiles?: string[];
  logFile: string;
  recordGitignoreAtStart?: boolean;
}

export interface FakeNpmInvocation {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  pid: number;
  startedAtMs: number;
  endedAtMs: number;
  gitignoreAtStart?: {
    existed: boolean;
    content?: string;
  };
}

export interface FakeNpmResult {
  logFile: string;
  readInvocations(): FakeNpmInvocation[];
}

const RECORDED_ENV_VARS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PWD",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_userconfig",
];

/**
 * Build the bash shim source for `npm`. The shim is invoked with the
 * argv passed to npm; it records argv, cwd, env, and timing into the
 * log file as one JSON line per invocation.
 *
 * The log entry is emitted via a Bash EXIT trap so signal-induced
 * termination still produces an entry.
 */
function buildShimScript(
  opts: FakeNpmOptions,
  payloadFiles: { stdoutFile: string | null; stderrFile: string | null },
): string {
  const logFile = JSON.stringify(opts.logFile);
  const exitCode = opts.exitCode ?? 0;
  const sleepSeconds = opts.sleepSeconds ?? 0;
  const exitCodeByWorkflowJson = JSON.stringify(opts.exitCodeByWorkflow ?? {});
  const sleepByWorkflowJson = JSON.stringify(opts.sleepByWorkflow ?? {});
  const trapSignals = opts.trapSignals ?? [];
  // Bash double-quoted strings do NOT interpret \n / \t escapes — passing the
  // bytes via `printf '%s' "<json-escaped>"` would emit literal backslashes.
  // Instead we materialize the configured bytes to temp files at helper-setup
  // time and `cat` them from the shim, which guarantees byte-for-byte fidelity
  // (including embedded NULs, control bytes, and UTF-8 multi-byte sequences).
  const stdoutFile = payloadFiles.stdoutFile
    ? JSON.stringify(payloadFiles.stdoutFile)
    : "";
  const stderrFile = payloadFiles.stderrFile
    ? JSON.stringify(payloadFiles.stderrFile)
    : "";
  const pidFile = opts.pidFile ? JSON.stringify(opts.pidFile) : "";
  const spawnGrandchild = !!opts.spawnGrandchild;
  const grandchildPidFile = opts.grandchildPidFile
    ? JSON.stringify(opts.grandchildPidFile)
    : "";
  const createFiles = (opts.createFiles ?? []).map((f) => JSON.stringify(f));
  const recordGitignoreAtStart = !!opts.recordGitignoreAtStart;

  const envVarLines = RECORDED_ENV_VARS.map(
    (name) => `["${name}"]="$(printenv ${name} 2>/dev/null || true)"`
  ).join("\n  ");

  const trapLines = trapSignals
    .map((sig) => `trap '' ${sig}`)
    .join("\n");

  return `#!/bin/bash
# Fake npm shim used by Spec 10.10 auto-install tests.
# Records invocation argv, cwd, env, and timing to a log file.
set -u

START_MS=$(($(date +%s%N) / 1000000))
SHIM_PID=$$
SHIM_CWD="$(pwd -P)"

# Snapshot recorded env vars BEFORE bash mutates them further.
declare -A RECORDED_ENV
for name in ${RECORDED_ENV_VARS.join(" ")}; do
  if printenv "$name" >/dev/null 2>&1; then
    RECORDED_ENV["$name"]="$(printenv "$name")"
  fi
done

# Build a JSON-escaped string from a raw string. Escapes \\, ", control chars.
__json_string() {
  python3 -c 'import json,sys
sys.stdout.write(json.dumps(sys.argv[1]))' "$1"
}

# Snapshot .gitignore at the moment of spawn (BEFORE any other side effect).
GITIGNORE_AT_START_JSON=""
${
  recordGitignoreAtStart
    ? `if [ -e ".gitignore" ] || [ -L ".gitignore" ]; then
  if [ -f ".gitignore" ]; then
    # Read content via python3 to preserve byte-for-byte content including
    # trailing newlines (bash command substitution strips trailing newlines).
    GITIGNORE_CONTENT_JSON=$(python3 -c '
import json, sys
with open(".gitignore", "rb") as f:
    data = f.read().decode("utf-8")
sys.stdout.write(json.dumps(data))
')
    GITIGNORE_AT_START_JSON=",\\"gitignoreAtStart\\":{\\"existed\\":true,\\"content\\":$GITIGNORE_CONTENT_JSON}"
  else
    GITIGNORE_AT_START_JSON=",\\"gitignoreAtStart\\":{\\"existed\\":true}"
  fi
else
  GITIGNORE_AT_START_JSON=",\\"gitignoreAtStart\\":{\\"existed\\":false}"
fi`
    : ""
}

# Capture argv as a JSON array.
ARGV_JSON="["
for i in "$@"; do
  if [ "$ARGV_JSON" != "[" ]; then ARGV_JSON+=","; fi
  ARGV_JSON+=$(__json_string "$i")
done
ARGV_JSON+="]"

# Capture env as a JSON object.
ENV_JSON="{"
__first=1
for name in "\${!RECORDED_ENV[@]}"; do
  if [ "$__first" = "0" ]; then ENV_JSON+=","; fi
  __first=0
  ENV_JSON+=$(__json_string "$name")
  ENV_JSON+=":"
  ENV_JSON+=$(__json_string "\${RECORDED_ENV[$name]}")
done
ENV_JSON+="}"

CWD_JSON=$(__json_string "$SHIM_CWD")

# Determine the workflow name from the cwd. The cwd should be
# .loopx/<workflow>/ — workflow name is the basename of the cwd.
WORKFLOW="$(basename "$SHIM_CWD")"

# Look up per-workflow overrides via python3 (avoids bash JSON parsing).
SLEEP_FOR=$(python3 -c '
import json, sys
overrides = json.loads(sys.argv[1])
default = ${sleepSeconds}
wf = sys.argv[2]
print(overrides.get(wf, default))
' '${sleepByWorkflowJson.replace(/'/g, "'\\''")}' "$WORKFLOW")

EXIT_CODE_FOR=$(python3 -c '
import json, sys
overrides = json.loads(sys.argv[1])
default = ${exitCode}
wf = sys.argv[2]
print(overrides.get(wf, default))
' '${exitCodeByWorkflowJson.replace(/'/g, "'\\''")}' "$WORKFLOW")

# Write log entry on exit (covers both normal exit and signal termination).
__finalize() {
  local end_ms=$(($(date +%s%N) / 1000000))
  local entry="{"
  entry+="\\"argv\\":$ARGV_JSON"
  entry+=",\\"cwd\\":$CWD_JSON"
  entry+=",\\"env\\":$ENV_JSON"
  entry+=",\\"pid\\":$SHIM_PID"
  entry+=",\\"startedAtMs\\":$START_MS"
  entry+=",\\"endedAtMs\\":$end_ms"
  entry+="$GITIGNORE_AT_START_JSON"
  entry+="}"
  printf '%s\\n' "$entry" >> ${logFile}
}
trap __finalize EXIT

${trapLines}

${
  pidFile
    ? `printf '%s' "$$" > ${pidFile}`
    : ""
}

${
  spawnGrandchild
    ? `sleep 3600 &
GRANDCHILD_PID=$!
${grandchildPidFile ? `printf '%s' "$GRANDCHILD_PID" > ${grandchildPidFile}` : ""}`
    : ""
}

${
  createFiles.length > 0
    ? createFiles
        .map(
          (f) =>
            `mkdir -p "$(dirname ${f})" 2>/dev/null || true; printf '' > ${f}`
        )
        .join("\n")
    : ""
}

# stderr "ready" marker (precedes any sleep, after pidFile/createFiles).
echo "ready" >&2

${stdoutFile ? `cat ${stdoutFile}` : ""}
${stderrFile ? `cat ${stderrFile} >&2` : ""}

if [ "$SLEEP_FOR" != "0" ]; then
  sleep "$SLEEP_FOR"
fi

exit "$EXIT_CODE_FOR"
`;
}

/**
 * Build a clean PATH directory whose contents are symlinks to every binary
 * present in `originalPath`, EXCLUDING any file named `npm`. The returned
 * value is a single-directory PATH string suitable for assigning to
 * `process.env.PATH`. The `extraDirs` array is the list of throw-away dirs
 * that must be cleaned up after the helper finishes.
 */
async function buildPathExcludingNpm(originalPath: string): Promise<string> {
  const cleanDir = await mkdtemp(join(tmpdir(), "loopx-fakenpm-clean-"));
  const seen = new Set<string>();
  for (const dir of originalPath.split(":").filter(Boolean)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "npm") continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      try {
        symlinkSync(join(dir, entry), join(cleanDir, entry));
      } catch {
        // Skip on collision/error — first PATH entry wins.
      }
    }
  }
  return cleanDir;
}

export async function withFakeNpm<T>(
  options: FakeNpmOptions,
  fn: (result: FakeNpmResult) => Promise<T>
): Promise<T> {
  const shimDir = await mkdtemp(join(tmpdir(), "loopx-fakenpm-"));
  const originalPath = process.env.PATH ?? "";
  let cleanDir: string | null = null;

  // Ensure parent directory of logFile exists.
  const logDir = options.logFile.split("/").slice(0, -1).join("/");
  if (logDir) {
    await mkdir(logDir, { recursive: true });
  }
  // Truncate log file.
  await writeFile(options.logFile, "");

  if (options.spawnFailure) {
    // SPEC §10.10 spawn-failure path requires `spawn("npm", ...)` to fail
    // with ENOENT — the spawn call must never produce a child process.
    //
    // We can't simply prepend a "block" entry to PATH because libc's
    // execvp() falls through to subsequent PATH entries when execve()
    // returns ENOENT (so a dangling symlink in the front dir is bypassed,
    // and a missing entry in the front dir means PATH search continues).
    //
    // Instead we materialize a clean PATH dir containing symlinks to every
    // binary present in the original PATH EXCEPT `npm`. We then point PATH
    // at that single dir, so npm is genuinely unresolvable while every
    // other tool (node, bun, git, tar, bash, python3, ...) remains
    // available via the symlinks.
    cleanDir = await buildPathExcludingNpm(originalPath);
    process.env.PATH = cleanDir;
  } else {
    // Materialize stdout/stderr payloads to temp files so the shim can
    // `cat` them and emit the bytes byte-for-byte (bash double-quoted
    // strings would otherwise mangle \n / \t / multi-byte sequences).
    let stdoutFile: string | null = null;
    let stderrFile: string | null = null;
    if (options.stdout && options.stdout.length > 0) {
      stdoutFile = join(shimDir, "stdout.bin");
      await writeFile(stdoutFile, options.stdout, "utf-8");
    }
    if (options.stderr && options.stderr.length > 0) {
      stderrFile = join(shimDir, "stderr.bin");
      await writeFile(stderrFile, options.stderr, "utf-8");
    }
    const shimPath = join(shimDir, "npm");
    await writeFile(
      shimPath,
      buildShimScript(options, { stdoutFile, stderrFile }),
      "utf-8",
    );
    chmodSync(shimPath, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
  }

  const result: FakeNpmResult = {
    logFile: options.logFile,
    readInvocations(): FakeNpmInvocation[] {
      if (!existsSync(options.logFile)) return [];
      const raw = readFileSync(options.logFile, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      return lines.map((line) => JSON.parse(line) as FakeNpmInvocation);
    },
  };

  try {
    return await fn(result);
  } finally {
    process.env.PATH = originalPath;
    await rm(shimDir, { recursive: true, force: true });
    if (cleanDir) {
      await rm(cleanDir, { recursive: true, force: true });
    }
  }
}
