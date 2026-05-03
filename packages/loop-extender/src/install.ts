import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  renameSync,
  lstatSync,
  unlinkSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  readlinkSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { tmpdir } from "node:os";
import { classifySource } from "./parsers/classify-source.js";
import {
  SUPPORTED_EXTENSIONS,
  NAME_PATTERN,
  isWorkflowByStructure,
} from "./discovery.js";
import { checkWorkflowVersion } from "./version-check.js";

/**
 * Signal context for the install subcommand (SPEC §10.10 "Signals during
 * `npm install`" and "Signals during the auto-install pass when no npm
 * child is active").
 *
 * The CLI install entry point (bin.ts) installs SIGINT / SIGTERM handlers
 * that consult `activeNpmChild` and forward the signal to the active npm
 * child's process group when one is running. The auto-install loop in
 * `runAutoInstall` checks `receivedSignal` between workflows, after each
 * spawn outcome, and at the head of each iteration so a signal observed
 * either while a child is active or while none is active causes the pass
 * to abort cleanly without further `.gitignore` synthesis or `npm install`
 * spawns. The aggregate failure report is suppressed when `receivedSignal`
 * is non-null at end-of-pass (the SPEC §10.10 "unless it had already been
 * emitted" carve-out — currently always falsy because the report is the
 * very last side effect of the pass).
 */
export interface InstallSignalContext {
  /** Returns the first signal observed by the install handlers (or null). */
  receivedSignal(): NodeJS.Signals | null;
  /** Records the active npm child so the signal handler can forward. */
  setActiveNpmChild(child: ChildProcess | null): void;
}

export interface InstallOptions {
  source: string;
  cwd: string;
  selectedWorkflow?: string | null; // -w <name>
  override: boolean; // -y
  noInstall: boolean; // --no-install (SPEC §10.10)
  runningVersion: string;
  /**
   * Optional signal context for SPEC §10.10. When omitted, the install
   * runs without signal awareness (test paths that don't need to observe
   * signal-driven termination).
   */
  signalContext?: InstallSignalContext;
}

interface WorkflowCandidate {
  name: string; // derived workflow name
  sourceDir: string; // path on disk (in the download/extraction dir)
}

interface ClassifiedSource {
  kind: "single-workflow" | "multi-workflow" | "zero-workflow";
  sourceRoot: string;
  candidates: WorkflowCandidate[];
  /** Only populated for single-workflow; for multi-workflow, candidates carry names. */
}

interface PreflightFailure {
  workflow: string;
  message: string;
}

// Fault-injection seam (TEST-SPEC §1.4). Only honored when NODE_ENV=test.
function getInstallFault(): { kind: "commit-fail-after"; n: number } | null {
  if (process.env.NODE_ENV !== "test") return null;
  const raw = process.env.LOOPX_TEST_INSTALL_FAULT;
  if (!raw) return null;
  const match = /^commit-fail-after:(\d+)$/.exec(raw);
  if (match) {
    return { kind: "commit-fail-after", n: Number(match[1]) };
  }
  return null;
}

interface AutoInstallFault {
  gitignoreWriteFail: Set<string>;
}

function getAutoInstallFault(): AutoInstallFault {
  const empty: AutoInstallFault = { gitignoreWriteFail: new Set() };
  if (process.env.NODE_ENV !== "test") return empty;
  const raw = process.env.LOOPX_TEST_AUTOINSTALL_FAULT;
  if (!raw) return empty;
  const fault: AutoInstallFault = { gitignoreWriteFail: new Set() };
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const kind = trimmed.slice(0, colon);
    const value = trimmed.slice(colon + 1);
    if (kind === "gitignore-write-fail") {
      for (const name of value.split(",")) {
        const n = name.trim();
        if (n) fault.gitignoreWriteFail.add(n);
      }
    }
  }
  return fault;
}

export async function installCommand(opts: InstallOptions): Promise<void> {
  const {
    source,
    cwd,
    selectedWorkflow,
    override,
    noInstall,
    runningVersion,
    signalContext,
  } = opts;

  let classifyResult;
  try {
    classifyResult = classifySource(source);
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  const loopxDir = join(cwd, ".loopx");
  mkdirSync(loopxDir, { recursive: true });

  // Download source into a tmp dir outside of .loopx/ so we never pollute
  // the project while preflight runs.
  const downloadDir = mkTempDir("loopx-install-src-");
  let sourceRoot: string;
  try {
    if (classifyResult.type === "git") {
      sourceRoot = await downloadGit(classifyResult.url, source, downloadDir);
    } else {
      sourceRoot = await downloadTarball(classifyResult.url, downloadDir);
    }
  } catch (err) {
    rmSync(downloadDir, { recursive: true, force: true });
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  let classified: ClassifiedSource;
  try {
    classified = classifyWorkflows(sourceRoot, classifyResult, source);
  } catch (err) {
    rmSync(downloadDir, { recursive: true, force: true });
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  if (classified.kind === "zero-workflow") {
    rmSync(downloadDir, { recursive: true, force: true });
    process.stderr.write(
      `Error: no installable workflows found in source '${source}'. Sources must contain at least one workflow (a subdirectory with one or more script files at the top level, or script files at the source root).\n`
    );
    process.exit(1);
  }

  // -w handling
  let selected: WorkflowCandidate[];
  if (selectedWorkflow) {
    if (classified.kind !== "multi-workflow") {
      rmSync(downloadDir, { recursive: true, force: true });
      process.stderr.write(
        `Error: -w / --workflow can only be used with multi-workflow sources. Source '${source}' is a single-workflow source.\n`
      );
      process.exit(1);
    }
    const match = classified.candidates.find(
      (c) => c.name === selectedWorkflow
    );
    if (!match) {
      rmSync(downloadDir, { recursive: true, force: true });
      process.stderr.write(
        `Error: workflow '${selectedWorkflow}' not found in source '${source}'.\n`
      );
      process.exit(1);
    }
    selected = [match];
  } else {
    selected = classified.candidates;
  }

  // Preflight
  const failures: PreflightFailure[] = [];
  const pkgWarnings: string[] = []; // non-blocking package.json warnings
  const warnedWorkflows = new Set<string>(); // workflows already warned about during preflight (SPEC §10.10 once-per-install dedup)
  const replacements = new Set<string>(); // workflow names to replace at commit time

  for (const wf of selected) {
    // Validate workflow name
    if (!NAME_PATTERN.test(wf.name)) {
      failures.push({
        workflow: wf.name,
        message: `Workflow name '${wf.name}' is invalid: must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`,
      });
      continue;
    }

    // Validate scripts within the workflow (names + base-name collisions)
    let scriptEntries: string[];
    try {
      scriptEntries = readdirSync(wf.sourceDir);
    } catch (err) {
      failures.push({
        workflow: wf.name,
        message: `Cannot read workflow source: ${(err as Error).message}`,
      });
      continue;
    }

    const scriptBasenames = new Map<string, string[]>();
    let invalidScriptNames: string[] = [];
    for (const entry of scriptEntries) {
      const full = join(wf.sourceDir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (!s.isFile()) continue;
      const ext = extname(entry);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      const scriptName = basename(entry, ext);
      if (!NAME_PATTERN.test(scriptName)) {
        invalidScriptNames.push(scriptName);
      }
      const arr = scriptBasenames.get(scriptName);
      if (arr) {
        arr.push(entry);
      } else {
        scriptBasenames.set(scriptName, [entry]);
      }
    }

    if (invalidScriptNames.length > 0) {
      failures.push({
        workflow: wf.name,
        message: `Workflow '${wf.name}' contains scripts with invalid names: ${invalidScriptNames.join(", ")}`,
      });
      // fall through so other failures can also be reported
    }

    let hasCollision = false;
    for (const [name, files] of scriptBasenames) {
      if (files.length > 1) {
        failures.push({
          workflow: wf.name,
          message: `Workflow '${wf.name}' has base-name collision: '${name}' has multiple files: ${files.join(", ")}`,
        });
        hasCollision = true;
      }
    }

    if (hasCollision) continue;

    // Destination-path collision (SPEC §10.5)
    const destPath = join(loopxDir, wf.name);
    if (existsSync(destPath) || isLinkSync(destPath)) {
      const isWorkflow = isWorkflowByStructure(destPath);
      if (!isWorkflow) {
        // Not a workflow-by-structure: refuse even with -y
        failures.push({
          workflow: wf.name,
          message: `Destination '${destPath}' exists and is not a workflow by structure; refusing to replace (use a different name or remove it manually).`,
        });
        continue;
      }
      if (!override) {
        failures.push({
          workflow: wf.name,
          message: `Workflow '${wf.name}' already exists at '${destPath}' (use -y to replace)`,
        });
        continue;
      }
      replacements.add(wf.name);
    }

    // Version check (SPEC §10.6, workflow-level only)
    const versionResult = checkWorkflowVersion(wf.sourceDir, runningVersion);
    switch (versionResult.kind) {
      case "unreadable":
        pkgWarnings.push(
          `Warning: workflow '${wf.name}' package.json is unreadable (permission denied); skipping check`
        );
        warnedWorkflows.add(wf.name);
        break;
      case "invalid-json":
        pkgWarnings.push(
          `Warning: workflow '${wf.name}' package.json contains invalid JSON; skipping check`
        );
        warnedWorkflows.add(wf.name);
        break;
      case "invalid-semver":
        pkgWarnings.push(
          `Warning: workflow '${wf.name}' has an invalid semver specifier for loopx in package.json; skipping check`
        );
        warnedWorkflows.add(wf.name);
        break;
      case "mismatched":
        if (!override) {
          failures.push({
            workflow: wf.name,
            message: `Workflow '${wf.name}' requires loopx version ${versionResult.range} but running version ${versionResult.running} does not satisfy that range (use -y to override)`,
          });
        }
        break;
      case "no-package-json":
      case "no-loopx-declared":
      case "satisfied":
        // No action
        break;
    }
  }

  // Emit package.json warnings regardless of outcome
  for (const w of pkgWarnings) {
    process.stderr.write(w + "\n");
  }

  if (failures.length > 0) {
    rmSync(downloadDir, { recursive: true, force: true });
    process.stderr.write("Error: install preflight failed:\n");
    for (const f of failures) {
      process.stderr.write(`  [${f.workflow}] ${f.message}\n`);
    }
    process.exit(1);
  }

  // Stage phase
  const stageDir = mkTempDir("loopx-install-stage-", loopxDir);
  try {
    for (const wf of selected) {
      const stagedPath = join(stageDir, wf.name);
      try {
        copyWorkflow(wf.sourceDir, stagedPath);
      } catch (err) {
        throw new Error(
          `Failed to stage workflow '${wf.name}': ${(err as Error).message}`
        );
      }
    }
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }

  // Commit phase
  const fault = getInstallFault();
  const committed: string[] = [];
  const uncommitted: string[] = [];
  let commitError: Error | null = null;

  for (let i = 0; i < selected.length; i++) {
    const wf = selected[i];

    if (fault && fault.kind === "commit-fail-after" && i >= fault.n) {
      uncommitted.push(wf.name);
      commitError = new Error(
        `LOOPX_TEST_INSTALL_FAULT: simulated commit failure after workflow #${fault.n}`
      );
      continue;
    }

    const destPath = join(loopxDir, wf.name);
    const stagedPath = join(stageDir, wf.name);

    try {
      if (replacements.has(wf.name)) {
        removeFsEntry(destPath);
      }
      renameSync(stagedPath, destPath);
      committed.push(wf.name);
    } catch (err) {
      commitError = err as Error;
      uncommitted.push(wf.name);
      for (let j = i + 1; j < selected.length; j++) {
        uncommitted.push(selected[j].name);
      }
      break;
    }
  }

  rmSync(stageDir, { recursive: true, force: true });
  rmSync(downloadDir, { recursive: true, force: true });

  if (commitError) {
    process.stderr.write(
      `Error: commit phase failed: ${commitError.message}\n`
    );
    if (committed.length > 0) {
      process.stderr.write(
        `  Committed workflows: ${committed.join(", ")}\n`
      );
    }
    if (uncommitted.length > 0) {
      process.stderr.write(
        `  Not committed: ${uncommitted.join(", ")}\n`
      );
    }
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────
  // Post-commit auto-install pass (SPEC §10.10)
  // ─────────────────────────────────────────────────────────────
  if (!noInstall) {
    const exitCode = await runAutoInstall(
      loopxDir,
      committed,
      runningVersion,
      warnedWorkflows,
      signalContext
    );
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// SPEC §10.10 auto-install pass.
// ─────────────────────────────────────────────────────────────────────

interface AutoInstallFailure {
  workflow: string;
  reason: string;
}

/**
 * Runs the post-commit auto-install pass over each committed workflow that has
 * a top-level `package.json`. Returns the exit code (0 on success, 1 if any
 * workflow's auto-install failed).
 *
 * Per SPEC §10.10:
 * - Iterates committed workflows in the order returned by the commit phase.
 * - For each workflow with a top-level `package.json`:
 *     1. Re-validate the committed `package.json` (skip silently if absent;
 *        warn + skip if malformed, with at-most-one warning per install).
 *     2. Run the `.gitignore` safeguard (synthesize on ENOENT, leave regular,
 *        treat any non-regular entry as a safeguard failure).
 *     3. Spawn `npm install` with cwd = workflow directory, env inherited
 *        unchanged, stdio inherited (streaming passthrough).
 * - Workflows without a top-level `package.json` are skipped silently.
 * - Failures are aggregated and an aggregate failure report is emitted
 *   on stderr at the end if any failures occurred.
 */
async function runAutoInstall(
  loopxDir: string,
  committed: string[],
  runningVersion: string,
  warnedFromPreflight: Set<string>,
  signalContext?: InstallSignalContext
): Promise<number> {
  const failures: AutoInstallFailure[] = [];
  const fault = getAutoInstallFault();
  // Per SPEC §10.10: dedupe warnings across the whole install operation,
  // not just the auto-install pass. Seed with workflows already warned at
  // preflight time so we don't double-warn here.
  const warnedAbout = new Set<string>(warnedFromPreflight);

  for (const workflowName of committed) {
    // SPEC §10.10 "Signals during the auto-install pass when no npm child is
    // active": at the head of each workflow iteration, check whether a signal
    // has been observed since the last child exited. If so, abort the pass
    // immediately — start no further `.gitignore` safeguards and no further
    // `npm install` children. The aggregate failure report is suppressed at
    // end-of-pass when receivedSignal is non-null.
    if (signalContext && signalContext.receivedSignal() !== null) {
      break;
    }
    const workflowDir = join(loopxDir, workflowName);
    const pkgPath = join(workflowDir, "package.json");

    // 1. Re-validate the committed package.json. SPEC §10.10:
    //   - Absent → silent skip (no auto-install).
    //   - Unreadable / invalid JSON / invalid semver / non-regular path
    //     → emit at-most-one workflow-level warning (matching SPEC §3.2)
    //       if not already emitted for this workflow during this install,
    //       then silent skip auto-install (and the .gitignore safeguard).
    let pkgLstat;
    try {
      pkgLstat = lstatSync(pkgPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue; // Silent skip: no top-level package.json.
      }
      // Other lstat failure → treat as malformed.
      if (!warnedAbout.has(workflowName)) {
        process.stderr.write(
          `Warning: workflow '${workflowName}' package.json could not be read; skipping auto-install\n`
        );
        warnedAbout.add(workflowName);
      }
      continue;
    }
    // SPEC §3.2 / §10.10: a non-regular package.json (directory, symlink,
    // FIFO, socket, etc.) is treated as malformed → warn + skip.
    if (!pkgLstat.isFile()) {
      if (!warnedAbout.has(workflowName)) {
        process.stderr.write(
          `Warning: workflow '${workflowName}' package.json is not a regular file; skipping auto-install\n`
        );
        warnedAbout.add(workflowName);
      }
      continue;
    }
    // Validate JSON / semver via checkWorkflowVersion.
    const versionResult = checkWorkflowVersion(workflowDir, runningVersion);
    let malformed = false;
    switch (versionResult.kind) {
      case "unreadable":
        if (!warnedAbout.has(workflowName)) {
          process.stderr.write(
            `Warning: workflow '${workflowName}' package.json is unreadable (permission denied); skipping auto-install\n`
          );
          warnedAbout.add(workflowName);
        }
        malformed = true;
        break;
      case "invalid-json":
        if (!warnedAbout.has(workflowName)) {
          process.stderr.write(
            `Warning: workflow '${workflowName}' package.json contains invalid JSON; skipping auto-install\n`
          );
          warnedAbout.add(workflowName);
        }
        malformed = true;
        break;
      case "invalid-semver":
        if (!warnedAbout.has(workflowName)) {
          process.stderr.write(
            `Warning: workflow '${workflowName}' has an invalid semver specifier for loopx in package.json; skipping auto-install\n`
          );
          warnedAbout.add(workflowName);
        }
        malformed = true;
        break;
      // satisfied / mismatched / no-loopx-declared / no-package-json:
      // none of these block auto-install (mismatched is a §10.6 preflight
      // concern that already gated commit).
      default:
        break;
    }
    if (malformed) continue;

    // 2. Run the .gitignore safeguard.
    const gitignoreOk = runGitignoreSafeguard(workflowDir, workflowName, fault);
    if (!gitignoreOk.ok) {
      failures.push({ workflow: workflowName, reason: gitignoreOk.reason });
      continue;
    }

    // 3. Spawn `npm install`.
    //
    // SPEC §10.10 "Signals during `npm install`": SIGINT / SIGTERM received
    // while an `npm install` child is active propagates to the child's
    // process group. We spawn detached so the child becomes its own process
    // group leader; the CLI signal handlers (bin.ts) consult the
    // signalContext's active-child slot and forward the signal via
    // `process.kill(-pid, sig)` plus a SPEC §7.3 5-second grace + SIGKILL
    // escalation. The child inherits stdin/stdout/stderr unchanged so the
    // npm streaming-passthrough contract from T-INST-119 holds.
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("npm", ["install"], {
          cwd: workflowDir,
          stdio: "inherit",
          env: process.env,
          detached: true,
        });
        if (signalContext) signalContext.setActiveNpmChild(child);
        child.on("error", (err) => {
          if (signalContext) signalContext.setActiveNpmChild(null);
          // Spawn failure (most commonly: npm not on PATH → ENOENT).
          reject(err);
        });
        child.on("exit", (code, signal) => {
          if (signalContext) signalContext.setActiveNpmChild(null);
          if (signal) {
            reject(
              Object.assign(new Error(`npm install terminated by ${signal}`), {
                code: "NPM_SIGNAL",
                signal,
              })
            );
            return;
          }
          if (code === 0) {
            resolve();
          } else {
            reject(
              Object.assign(
                new Error(`npm install exited with code ${code}`),
                { code: "NPM_NONZERO_EXIT", exitCode: code }
              )
            );
          }
        });
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        code?: string;
        exitCode?: number;
        signal?: NodeJS.Signals;
      };
      // SPEC §10.10 "Signals during `npm install`": when the npm child was
      // terminated by a forwarded SIGINT / SIGTERM (originating from the CLI
      // signal handler in bin.ts), the surfacing terminal outcome is the
      // signal itself, not a per-workflow auto-install failure. Suppress the
      // failure entry in that case so the aggregate report does not list a
      // signal-induced exit as if it were an install error. The pass also
      // breaks immediately after this iteration (the head-of-loop check on
      // receivedSignal aborts further workflows).
      const sigObserved =
        signalContext !== undefined &&
        signalContext.receivedSignal() !== null;
      if (e.code === "NPM_SIGNAL" && sigObserved) {
        // Skip recording — terminal outcome is the signal.
      } else if (e.code === "ENOENT") {
        failures.push({
          workflow: workflowName,
          reason: "npm install spawn failed (npm not found on PATH)",
        });
      } else if (e.code === "NPM_NONZERO_EXIT") {
        failures.push({
          workflow: workflowName,
          reason: `npm install exited with code ${e.exitCode}`,
        });
      } else if (e.code === "NPM_SIGNAL") {
        failures.push({
          workflow: workflowName,
          reason: `npm install terminated by signal ${e.signal}`,
        });
      } else {
        failures.push({
          workflow: workflowName,
          reason: `npm install failed: ${e.message}`,
        });
      }
    }
  }

  // SPEC §10.10 "Signals during the auto-install pass when no npm child is
  // active": when receivedSignal is non-null at end-of-pass, suppress the
  // final aggregate failure report. The "unless it had already been emitted"
  // carve-out is structurally satisfied here because the report is the very
  // last side effect of the pass — if we reached this point with the
  // receivedSignal set, the report has not been emitted.
  if (signalContext && signalContext.receivedSignal() !== null) {
    return 0;
  }

  if (failures.length > 0) {
    process.stderr.write("Error: auto-install failures:\n");
    for (const f of failures) {
      process.stderr.write(`  [${f.workflow}] ${f.reason}\n`);
    }
    return 1;
  }
  return 0;
}

/**
 * Apply the SPEC §10.10 .gitignore safeguard. Returns ok=true and writes a
 * synthesized .gitignore on ENOENT; returns ok=true unchanged on a regular
 * file; returns ok=false (with a reason) on any non-regular entry, on a
 * non-ENOENT lstat failure, or on a write failure when synthesizing.
 */
function runGitignoreSafeguard(
  workflowDir: string,
  workflowName: string,
  fault: AutoInstallFault
): { ok: true } | { ok: false; reason: string } {
  const gitignorePath = join(workflowDir, ".gitignore");
  let st;
  try {
    st = lstatSync(gitignorePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Synthesize a .gitignore with `node_modules`. The test-only
      // `gitignore-write-fail:<workflow>` seam (TEST-SPEC §1.4) short-
      // circuits this branch with a simulated EACCES write failure
      // before any bytes touch disk; SPEC §10.10's safeguard-failure
      // dispatch then runs identically to a real EACCES write failure.
      if (fault.gitignoreWriteFail.has(workflowName)) {
        return {
          ok: false,
          reason: `failed to synthesize .gitignore: EACCES: permission denied, open '${gitignorePath}'`,
        };
      }
      try {
        writeFileSync(gitignorePath, "node_modules\n", "utf-8");
        return { ok: true };
      } catch (writeErr) {
        return {
          ok: false,
          reason: `failed to synthesize .gitignore: ${(writeErr as Error).message}`,
        };
      }
    }
    return {
      ok: false,
      reason: `failed to lstat .gitignore: ${(err as Error).message}`,
    };
  }
  if (st.isFile()) {
    return { ok: true };
  }
  // Any non-regular entry (directory, symlink, FIFO, socket, etc.).
  return {
    ok: false,
    reason: `.gitignore exists but is not a regular file (${describeFsType(st)})`,
  };
}

function describeFsType(st: NonNullable<ReturnType<typeof lstatSync>>): string {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "directory";
  if (st.isFIFO()) return "FIFO";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice()) return "block device";
  if (st.isCharacterDevice()) return "character device";
  return "non-regular";
}

function mkTempDir(prefix: string, parent?: string): string {
  const base = parent ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const name = `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadGit(
  url: string,
  _source: string,
  downloadDir: string
): Promise<string> {
  const repoDir = join(downloadDir, "repo");
  try {
    execFileSync("git", ["clone", "--depth", "1", url, repoDir], {
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr;
    const detail = stderr ? stderr.toString().trim() : "";
    throw new Error(`git clone failed for ${url}${detail ? `\n${detail}` : ""}`);
  }
  return repoDir;
}

async function downloadTarball(
  url: string,
  downloadDir: string
): Promise<string> {
  const tarPath = join(downloadDir, "archive.tar.gz");

  let data: Buffer;
  try {
    if (url.startsWith("file://")) {
      const filePath = url.replace(/^file:\/\//, "");
      data = Buffer.from(readFileSync(filePath));
    } else {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} downloading ${url}`);
      }
      data = Buffer.from(await response.arrayBuffer());
    }
  } catch (err) {
    throw new Error(
      `Failed to download ${url}: ${(err as Error).message}`
    );
  }

  writeFileSync(tarPath, data);

  const extractDir = join(downloadDir, "extract");
  mkdirSync(extractDir, { recursive: true });

  try {
    execFileSync("tar", ["xzf", tarPath, "-C", extractDir], {
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr;
    const detail = stderr ? stderr.toString().trim() : "";
    throw new Error(`Failed to extract tarball${detail ? `: ${detail}` : ""}`);
  }

  // Wrapper-directory stripping (SPEC §10.2)
  const entries = readdirSync(extractDir);
  if (entries.length === 0) {
    throw new Error("tarball is empty");
  }
  if (entries.length === 1) {
    const only = join(extractDir, entries[0]);
    let s;
    try {
      s = statSync(only);
    } catch {
      throw new Error(`Cannot stat tarball entry '${entries[0]}'`);
    }
    if (s.isDirectory()) {
      return only;
    }
  }
  return extractDir;
}

function classifyWorkflows(
  sourceRoot: string,
  classifyResult: { type: "git" | "tarball"; url: string },
  originalSource: string
): ClassifiedSource {
  // Is there a top-level script file?
  let entries: string[];
  try {
    entries = readdirSync(sourceRoot);
  } catch (err) {
    throw new Error(`Cannot read source root: ${(err as Error).message}`);
  }

  let rootHasScript = false;
  for (const entry of entries) {
    const full = join(sourceRoot, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry))) {
      rootHasScript = true;
      break;
    }
  }

  if (rootHasScript) {
    const name = deriveSingleWorkflowName(classifyResult, originalSource);
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Derived workflow name '${name}' is invalid: must match [a-zA-Z0-9_][a-zA-Z0-9_-]*`
      );
    }
    return {
      kind: "single-workflow",
      sourceRoot,
      candidates: [{ name, sourceDir: sourceRoot }],
    };
  }

  // Multi-workflow: each top-level subdir that is a workflow by structure.
  const candidates: WorkflowCandidate[] = [];
  for (const entry of entries) {
    const full = join(sourceRoot, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (!isWorkflowByStructure(full)) continue;
    candidates.push({ name: entry, sourceDir: full });
  }

  if (candidates.length === 0) {
    return { kind: "zero-workflow", sourceRoot, candidates: [] };
  }
  return { kind: "multi-workflow", sourceRoot, candidates };
}

function deriveSingleWorkflowName(
  classifyResult: { type: "git" | "tarball"; url: string },
  originalSource: string
): string {
  if (classifyResult.type === "git") {
    return deriveRepoName(classifyResult.url, originalSource);
  }
  return deriveArchiveNameFromUrl(classifyResult.url);
}

function deriveRepoName(url: string, source: string): string {
  if (source.startsWith("git@")) {
    const match = source.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
    const colonMatch = source.match(/:.*\/([^/]+?)(?:\.git)?$/);
    if (colonMatch) return colonMatch[1];
  }

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    let last = segments[segments.length - 1] || "repo";
    if (last.endsWith(".git")) {
      last = last.slice(0, -4);
    }
    return last;
  } catch {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : "repo";
  }
}

function deriveArchiveNameFromUrl(rawUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    pathname = rawUrl;
  }
  const filename = basename(pathname);
  return filename.replace(/\.(tar\.gz|tgz)$/, "");
}

function copyWorkflow(src: string, dest: string): void {
  // Manual recursive copy. Excludes `.git/` — git clones bring a history
  // directory that is not part of the workflow. An unreadable workflow-root
  // `package.json` is tolerated by temporarily restoring the owner read bit
  // for the copy only; any OTHER unreadable file fails the stage (per SPEC
  // §10.7 "any write fails during staging → install fails, .loopx/ unchanged"
  // — TEST-SPEC T-INST-79).
  //
  // `src` is the workflow root directory itself. We create `dest` then
  // iterate its children — children are "root-level" entries of the workflow;
  // grandchildren and deeper are not.
  let resolvedSrc = src;
  let rootStat = lstatSync(resolvedSrc);
  if (rootStat.isSymbolicLink()) {
    // SPEC §10.11: a selected top-level workflow entry that is a symlink to
    // a directory is installed as a real directory at the destination,
    // containing a copy of the symlink target's workflow contents. Resolve
    // the symlink and proceed against the target — the destination is
    // created via mkdirSync below (no symlinkSync), so the materialized
    // directory is real.
    resolvedSrc = realpathSync(src);
    rootStat = lstatSync(resolvedSrc);
  }
  if (!rootStat.isDirectory()) {
    // Shouldn't happen for a workflow, but handle defensively.
    throw new Error(`Workflow source is not a directory: ${src}`);
  }
  mkdirSync(dest, { recursive: true, mode: rootStat.mode & 0o777 });
  for (const entry of readdirSync(resolvedSrc)) {
    if (entry === ".git") continue;
    copyEntry(
      join(resolvedSrc, entry),
      join(dest, entry),
      /*isRootLevel*/ true,
    );
  }
  try {
    chmodSync(dest, rootStat.mode & 0o777);
  } catch {
    // best-effort
  }
}

function copyEntry(src: string, dest: string, isRootLevel: boolean): void {
  const srcStat = lstatSync(src);
  if (srcStat.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  if (srcStat.isDirectory()) {
    mkdirSync(dest, { recursive: true, mode: srcStat.mode & 0o777 });
    for (const entry of readdirSync(src)) {
      if (entry === ".git") continue;
      copyEntry(join(src, entry), join(dest, entry), /*isRootLevel*/ false);
    }
    try {
      chmodSync(dest, srcStat.mode & 0o777);
    } catch {
      // best-effort
    }
    return;
  }
  if (srcStat.isFile()) {
    const origMode = srcStat.mode & 0o777;
    const isRootPackageJson = isRootLevel && basename(src) === "package.json";
    let restoredReadability = false;
    if ((origMode & 0o400) === 0 && isRootPackageJson) {
      try {
        chmodSync(src, origMode | 0o600);
        restoredReadability = true;
      } catch {
        // fall through — copyFileSync will surface the EACCES
      }
    }
    try {
      copyFileSync(src, dest);
    } finally {
      if (restoredReadability) {
        try {
          chmodSync(src, origMode);
        } catch {
          // best-effort restore
        }
      }
    }
    try {
      chmodSync(dest, origMode);
    } catch {
      // best-effort
    }
    return;
  }
}

function isLinkSync(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeFsEntry(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  rmSync(path, { recursive: true, force: true });
}
