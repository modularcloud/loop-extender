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
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { classifySource } from "./parsers/classify-source.js";
import {
  SUPPORTED_EXTENSIONS,
  NAME_PATTERN,
  isWorkflowByStructure,
} from "./discovery.js";
import { checkWorkflowVersion, formatWarning } from "./version-check.js";

export interface InstallOptions {
  source: string;
  cwd: string;
  selectedWorkflow?: string | null; // -w <name>
  override: boolean; // -y
  noInstall: boolean; // --no-install
  runningVersion: string;
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

interface AutoInstallSignalState {
  abortedSignal: NodeJS.Signals | null;
  activeChildPid: number | null;
}

// Fault-injection seam (TEST-SPEC §1.4). Only honored when NODE_ENV=test.
function getInstallFault():
  | { kind: "commit-fail-after"; n: number; stagingFail: Set<string> }
  | { kind: "staging-only"; stagingFail: Set<string> }
  | null {
  if (process.env.NODE_ENV !== "test") return null;
  const raw = process.env.LOOPX_TEST_INSTALL_FAULT;
  if (!raw) return null;
  const stagingFail = new Set<string>();
  let commitAfter: number | null = null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const commitMatch = /^commit-fail-after:(\d+)$/.exec(trimmed);
    if (commitMatch) {
      commitAfter = Number(commitMatch[1]);
      continue;
    }
    const stagingMatch = /^staging-fail:(.+)$/.exec(trimmed);
    if (stagingMatch) {
      for (const name of stagingMatch[1].split(/[,+]/).map((v) => v.trim()).filter(Boolean)) {
        stagingFail.add(name);
      }
    }
  }
  if (commitAfter !== null) {
    return { kind: "commit-fail-after", n: commitAfter, stagingFail };
  }
  if (stagingFail.size > 0) {
    return { kind: "staging-only", stagingFail };
  }
  return null;
}

export async function installCommand(opts: InstallOptions): Promise<void> {
  const {
    source,
    cwd,
    selectedWorkflow,
    override,
    noInstall,
    runningVersion,
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

  applySourceTargetFaults(classified.sourceRoot);

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
  const pkgWarnedWorkflows = new Set<string>();
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

    try {
      validateSourceSymlinks(wf.sourceDir, classified.sourceRoot);
    } catch (err) {
      failures.push({
        workflow: wf.name,
        message: `Workflow '${wf.name}' contains a source symlink error: ${(err as Error).message}`,
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
    if (isNonRegularPackageJson(wf.sourceDir)) {
      const warning = `Warning: workflow '${wf.name}' package.json is not a regular file; skipping check`;
      pkgWarnings.push(warning);
      pkgWarnedWorkflows.add(wf.name);
      continue;
    }
    const versionResult = checkWorkflowVersion(wf.sourceDir, runningVersion);
    const warning = formatWarning(versionResult, wf.name);
    if (warning && versionResult.kind !== "mismatched") {
      pkgWarnings.push(warning);
      pkgWarnedWorkflows.add(wf.name);
    }
    switch (versionResult.kind) {
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
  const fault = getInstallFault();
  if (process.env.NODE_ENV === "test" && process.env.LOOPX_TEST_INSTALL_STAGE_MARKER) {
    writeFileSync(
      process.env.LOOPX_TEST_INSTALL_STAGE_MARKER,
      JSON.stringify({ stageDir }),
      "utf-8"
    );
  }
  try {
    for (const wf of selected) {
      const stagedPath = join(stageDir, wf.name);
      try {
        if (fault?.stagingFail.has(wf.name)) {
          throw new Error("LOOPX_TEST_INSTALL_FAULT: simulated staging failure");
        }
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
  const committed: string[] = [];
  const uncommitted: string[] = [];
  let commitError: Error | null = null;

  for (let i = 0; i < selected.length; i++) {
    const wf = selected[i];

    if (fault?.kind === "commit-fail-after" && i >= fault.n) {
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

  if (!noInstall) {
    const autoInstallFailures = await runPostCommitInstall(
      loopxDir,
      committed,
      runningVersion,
      pkgWarnedWorkflows
    );
    if (autoInstallFailures.length > 0) {
      process.stderr.write("Error: auto-install failed:\n");
      for (const f of autoInstallFailures) {
        process.stderr.write(`  [${f.workflow}] ${f.message}\n`);
      }
      await maybePauseAutoInstall("post-aggregate-report", {
        workflows: committed,
        processed: committed,
        current: null,
        activeChildPid: null,
        loopxDir,
      });
      process.exit(1);
    }
  }
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
      const response = await fetch(url, { redirect: "manual" });
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
  const rootStat = statSync(src);
  if (!rootStat.isDirectory()) {
    // Shouldn't happen for a workflow, but handle defensively.
    throw new Error(`Workflow source is not a directory: ${src}`);
  }
  mkdirSync(dest, { recursive: true, mode: rootStat.mode & 0o777 });
  for (const entry of readdirSync(src)) {
    if (entry === ".git") continue;
    copyEntry(join(src, entry), join(dest, entry), /*isRootLevel*/ true);
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
    const targetStat = statSync(src);
    if (targetStat.isDirectory()) {
      mkdirSync(dest, { recursive: true, mode: targetStat.mode & 0o777 });
      for (const entry of readdirSync(src)) {
        if (entry === ".git") continue;
        copyEntry(join(src, entry), join(dest, entry), false);
      }
      chmodSync(dest, targetStat.mode & 0o777);
      return;
    }
    if (targetStat.isFile()) {
      copyFileSync(src, dest);
      chmodSync(dest, targetStat.mode & 0o777);
      return;
    }
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

function applySourceTargetFaults(sourceRoot: string): void {
  if (process.env.NODE_ENV !== "test") return;
  const raw = process.env.LOOPX_TEST_INSTALL_FAULT;
  if (!raw) return;
  for (const part of raw.split(";")) {
    const match = /^(source-target-replace-with-fifo|source-target-replace-with-char-device|source-target-replace-with-block-device):(.+)$/.exec(part.trim());
    if (!match) continue;
    for (const rel of match[2].split(",").map((v) => v.trim()).filter(Boolean)) {
      const target = join(sourceRoot, rel);
      try {
        rmSync(target, { recursive: true, force: true });
        if (match[1] === "source-target-replace-with-fifo") {
          execFileSync("mkfifo", [target]);
        } else if (match[1] === "source-target-replace-with-char-device") {
          execFileSync("mknod", [target, "c", "1", "7"]);
        } else {
          execFileSync("mknod", [target, "b", "7", "0"]);
        }
      } catch {
        // best-effort seam
      }
    }
  }
}

function validateSourceSymlinks(path: string, sourceRoot: string): void {
  const rootReal = realpathSync(sourceRoot);
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      let targetStat;
      let targetReal;
      try {
        targetStat = statSync(full);
        targetReal = realpathSync(full);
      } catch {
        throw new Error(`${entry} points to a missing or cyclic target`);
      }
      if (!targetReal.startsWith(rootReal + "/") && targetReal !== rootReal) {
        throw new Error(`${entry} points outside the install source`);
      }
      if (!targetStat.isFile() && !targetStat.isDirectory()) {
        throw new Error(`${entry} points to a non-regular target`);
      }
    }
    if (st.isDirectory()) {
      validateSourceSymlinks(full, sourceRoot);
    }
  }
}

async function runPostCommitInstall(
  loopxDir: string,
  workflows: string[],
  runningVersion: string,
  pkgWarnedWorkflows: Set<string>
): Promise<PreflightFailure[]> {
  const failures: PreflightFailure[] = [];
  const fault = getAutoInstallFault();
  const signalState: AutoInstallSignalState = {
    abortedSignal: null,
    activeChildPid: null,
  };
  const signalHandler = (signal: NodeJS.Signals) => {
    signalState.abortedSignal = signal;
    if (signalState.activeChildPid !== null) {
      killProcessGroup(signalState.activeChildPid, signal);
      setTimeout(() => {
        if (signalState.activeChildPid !== null) {
          killProcessGroup(signalState.activeChildPid, "SIGKILL");
        }
      }, 5000).unref();
      return;
    }
    process.exit(signalExitCode(signal));
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  const processed: string[] = [];
  for (const workflow of workflows) {
    if (workflow === workflows[0]) {
      await maybePauseAutoInstall("before-first-workflow", {
        workflows,
        processed,
        current: workflow,
        activeChildPid: null,
        loopxDir,
      });
      exitIfSignaled(signalState);
    } else if (processed.length === 1) {
      await maybePauseAutoInstall("between-workflows-after-first", {
        workflows,
        processed,
        current: workflow,
        activeChildPid: null,
        loopxDir,
      });
      exitIfSignaled(signalState);
    }

    const workflowDir = join(loopxDir, workflow);
    applyPackageJsonFaults(workflowDir, workflow, fault);
    if (fault.packageJsonMakeUnreadable.has(workflow)) {
      try {
        chmodSync(join(workflowDir, "package.json"), 0o000);
      } catch {
        // The subsequent version check will surface the readable state.
      }
    }
    if (isNonRegularPackageJson(workflowDir)) {
      const warning = `Warning: workflow '${workflow}' package.json is not a regular file; skipping check`;
      if (!pkgWarnedWorkflows.has(workflow)) {
        process.stderr.write(warning + "\n");
        pkgWarnedWorkflows.add(workflow);
      }
      processed.push(workflow);
      continue;
    }
    const versionResult = checkWorkflowVersion(workflowDir, runningVersion);
    if (
      versionResult.kind === "no-package-json" ||
      versionResult.kind === "unreadable" ||
      versionResult.kind === "invalid-json" ||
      versionResult.kind === "invalid-semver"
    ) {
      const warning = formatWarning(versionResult, workflow);
      if (warning && !pkgWarnedWorkflows.has(workflow)) {
        process.stderr.write(warning + "\n");
        pkgWarnedWorkflows.add(workflow);
      }
      continue;
    }

    const gitignoreFailure = ensureNodeModulesGitignore(
      workflowDir,
      workflow,
      workflow === workflows[0]
    );
    if (gitignoreFailure) {
      failures.push(gitignoreFailure);
      await maybePauseAutoInstall("post-safeguard-failure-first", {
        workflows,
        processed,
        current: workflow,
        activeChildPid: null,
        loopxDir,
      });
      exitIfSignaled(signalState);
      processed.push(workflow);
      continue;
    }

    await maybePauseAutoInstall("pre-spawn-first", {
      workflows,
      processed,
      current: workflow,
      activeChildPid: null,
      loopxDir,
      gitignoreWorkflow: workflow,
    });
    exitIfSignaled(signalState);

    if (fault.npmSpawnFail.has(workflow) || (workflow === workflows[0] && fault.npmSpawnFailFirst)) {
      failures.push({
        workflow,
        message: "npm install failed to start: simulated spawn failure",
      });
      await maybePauseAutoInstall("post-spawn-failure-first", {
        workflows,
        processed,
        current: workflow,
        activeChildPid: null,
        loopxDir,
      });
      exitIfSignaled(signalState);
      processed.push(workflow);
      continue;
    }

    const result = await spawnNpmInstall(workflowDir, signalState, async (pid) => {
      await maybePauseAutoInstall("child-active-after-failure", {
        workflows,
        processed,
        current: workflow,
        activeChildPid: pid,
        loopxDir,
      });
    }, failures.length > 0);
    exitIfSignaled(signalState);

    if (result.error) {
      failures.push({
        workflow,
        message: `npm install failed to start: ${result.error.message}`,
      });
    } else if (result.status !== 0) {
      failures.push({
        workflow,
        message: `npm install exited with status ${result.status ?? 1}`,
      });
    }
    await maybePauseAutoInstall("post-exit-first", {
      workflows,
      processed,
      current: workflow,
      activeChildPid: null,
      loopxDir,
    });
    exitIfSignaled(signalState);
    processed.push(workflow);
  }
  process.removeListener("SIGINT", signalHandler);
  process.removeListener("SIGTERM", signalHandler);
  return failures;
}

function spawnNpmInstall(
  workflowDir: string,
  signalState: AutoInstallSignalState,
  onChildActiveAfterFailure: (pid: number) => Promise<void>,
  hasPriorFailure: boolean
): Promise<{ status: number | null; error?: Error }> {
  return new Promise((resolvePromise) => {
    const child = spawn("npm", ["install"], {
      cwd: workflowDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid) {
      signalState.activeChildPid = child.pid;
      if (hasPriorFailure) {
        void onChildActiveAfterFailure(child.pid);
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(normalizeTestNpmOutput(chunk.toString()));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(normalizeTestNpmOutput(chunk.toString()));
    });
    child.on("error", (error) => {
      signalState.activeChildPid = null;
      resolvePromise({ status: null, error });
    });
    child.on("close", (code) => {
      signalState.activeChildPid = null;
      resolvePromise({ status: code ?? 1 });
    });
  });
}

function normalizeTestNpmOutput(output: string): string {
  if (process.env.NODE_ENV !== "test") return output;
  return output.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
}

function ensureNodeModulesGitignore(
  workflowDir: string,
  workflow: string,
  isFirstWorkflow = false
): PreflightFailure | null {
  const gitignorePath = join(workflowDir, ".gitignore");
  const fault = getAutoInstallFault();
  applyGitignoreFaultsBeforeLstat(workflowDir, workflow, fault);
  if (fault.gitignoreLstatFail.has(workflow)) {
    return {
      workflow,
      message: ".gitignore safeguard failed: simulated lstat failure",
    };
  }
  if (fault.gitignoreReplaceWithFifo.has(workflow)) {
    try {
      execFileSync("mkfifo", [gitignorePath]);
    } catch {
      try {
        writeFileSync(gitignorePath, "");
      } catch {
        // fall through to lstat handling
      }
    }
  }
  if (fault.gitignoreWriteFail.has(workflow) || (isFirstWorkflow && fault.gitignoreWriteFailFirst)) {
    return {
      workflow,
      message: ".gitignore safeguard failed: simulated write failure",
    };
  }

  try {
    const st = lstatSync(gitignorePath);
    if (!st.isFile()) {
      return {
        workflow,
        message: ".gitignore safeguard failed: existing .gitignore is not a regular file",
      };
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        workflow,
        message: `.gitignore safeguard failed: ${(err as Error).message}`,
      };
    }
  }

  try {
    if (fault.gitignorePartialWriteFail.has(workflow)) {
      writeFileSync(gitignorePath, "node", { mode: 0o600 });
      writeFileSync(
        join(workflowDir, ".gitignore.seam-observed-mode"),
        String(lstatSync(gitignorePath).mode & 0o777)
      );
      return {
        workflow,
        message: ".gitignore safeguard failed: simulated partial write failure",
      };
    }
    writeFileSync(gitignorePath, "node_modules\n", { flag: "wx" });
    return null;
  } catch (err) {
    return {
      workflow,
      message: `.gitignore safeguard failed: ${(err as Error).message}`,
    };
  }
}

function getAutoInstallFault(): {
  gitignoreWriteFail: Set<string>;
  gitignoreWriteFailFirst: boolean;
  npmSpawnFail: Set<string>;
  npmSpawnFailFirst: boolean;
  packageJsonMakeUnreadable: Set<string>;
  gitignoreReplaceWithFifo: Set<string>;
  gitignoreReplaceWithSocket: Set<string>;
  gitignoreReplaceWithCharDevice: Set<string>;
  gitignoreReplaceWithBlockDevice: Set<string>;
  gitignoreLstatFail: Set<string>;
  gitignorePartialWriteFail: Set<string>;
  gitignoreMakeUnreadable: Set<string>;
  gitignoreReplaceWithSymlink: Map<string, string>;
  packageJsonReplaceWithSymlink: Map<string, string>;
  packageJsonReplaceWithFifo: Set<string>;
  packageJsonReplaceWithSocket: Set<string>;
  packageJsonReplaceWithCharDevice: Set<string>;
  packageJsonReplaceWithBlockDevice: Set<string>;
  packageJsonReplaceWithValid: Set<string>;
  packageJsonRemove: Set<string>;
} {
  const empty = {
    gitignoreWriteFail: new Set<string>(),
    gitignoreWriteFailFirst: false,
    npmSpawnFail: new Set<string>(),
    npmSpawnFailFirst: false,
    packageJsonMakeUnreadable: new Set<string>(),
    gitignoreReplaceWithFifo: new Set<string>(),
    gitignoreReplaceWithSocket: new Set<string>(),
    gitignoreReplaceWithCharDevice: new Set<string>(),
    gitignoreReplaceWithBlockDevice: new Set<string>(),
    gitignoreLstatFail: new Set<string>(),
    gitignorePartialWriteFail: new Set<string>(),
    gitignoreMakeUnreadable: new Set<string>(),
    gitignoreReplaceWithSymlink: new Map<string, string>(),
    packageJsonReplaceWithSymlink: new Map<string, string>(),
    packageJsonReplaceWithFifo: new Set<string>(),
    packageJsonReplaceWithSocket: new Set<string>(),
    packageJsonReplaceWithCharDevice: new Set<string>(),
    packageJsonReplaceWithBlockDevice: new Set<string>(),
    packageJsonReplaceWithValid: new Set<string>(),
    packageJsonRemove: new Set<string>(),
  };
  if (process.env.NODE_ENV !== "test") return empty;
  const raw = process.env.LOOPX_TEST_AUTOINSTALL_FAULT;
  if (!raw) return empty;
  const result = {
    gitignoreWriteFail: new Set<string>(),
    gitignoreWriteFailFirst: false,
    npmSpawnFail: new Set<string>(),
    npmSpawnFailFirst: false,
    packageJsonMakeUnreadable: new Set<string>(),
    gitignoreReplaceWithFifo: new Set<string>(),
    gitignoreReplaceWithSocket: new Set<string>(),
    gitignoreReplaceWithCharDevice: new Set<string>(),
    gitignoreReplaceWithBlockDevice: new Set<string>(),
    gitignoreLstatFail: new Set<string>(),
    gitignorePartialWriteFail: new Set<string>(),
    gitignoreMakeUnreadable: new Set<string>(),
    gitignoreReplaceWithSymlink: new Map<string, string>(),
    packageJsonReplaceWithSymlink: new Map<string, string>(),
    packageJsonReplaceWithFifo: new Set<string>(),
    packageJsonReplaceWithSocket: new Set<string>(),
    packageJsonReplaceWithCharDevice: new Set<string>(),
    packageJsonReplaceWithBlockDevice: new Set<string>(),
    packageJsonReplaceWithValid: new Set<string>(),
    packageJsonRemove: new Set<string>(),
  };
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed === "gitignore-write-fail-first") {
      result.gitignoreWriteFailFirst = true;
      continue;
    }
    if (trimmed === "npm-spawn-fail-first") {
      result.npmSpawnFailFirst = true;
      continue;
    }
    const kv = /^(gitignore-replace-with-symlink|package-json-replace-with-symlink):([^=]+)=(.+)$/.exec(trimmed);
    if (kv) {
      const target =
        kv[1] === "gitignore-replace-with-symlink"
          ? result.gitignoreReplaceWithSymlink
          : result.packageJsonReplaceWithSymlink;
      for (const name of kv[2].split(/[,+]/).map((v) => v.trim()).filter(Boolean)) {
        target.set(name, kv[3]);
      }
      continue;
    }
    const match = /^(gitignore-write-fail|npm-spawn-fail|package-json-make-unreadable|gitignore-replace-with-fifo|gitignore-replace-with-socket|gitignore-replace-with-char-device|gitignore-replace-with-block-device|gitignore-lstat-fail|gitignore-partial-write-fail|gitignore-make-unreadable|package-json-replace-with-fifo|package-json-replace-with-socket|package-json-replace-with-char-device|package-json-replace-with-block-device|package-json-replace-with-valid|package-json-remove):(.+)$/.exec(trimmed);
    if (!match) continue;
    const names = match[2].split(/[,+]/).map((name) => name.trim()).filter(Boolean);
    const target =
      match[1] === "gitignore-write-fail"
        ? result.gitignoreWriteFail
        : match[1] === "npm-spawn-fail"
          ? result.npmSpawnFail
          : match[1] === "package-json-make-unreadable" ? result.packageJsonMakeUnreadable
          : match[1] === "gitignore-replace-with-fifo" ? result.gitignoreReplaceWithFifo
          : match[1] === "gitignore-replace-with-socket" ? result.gitignoreReplaceWithSocket
          : match[1] === "gitignore-replace-with-char-device" ? result.gitignoreReplaceWithCharDevice
          : match[1] === "gitignore-replace-with-block-device" ? result.gitignoreReplaceWithBlockDevice
          : match[1] === "gitignore-lstat-fail" ? result.gitignoreLstatFail
          : match[1] === "gitignore-partial-write-fail" ? result.gitignorePartialWriteFail
          : match[1] === "gitignore-make-unreadable" ? result.gitignoreMakeUnreadable
          : match[1] === "package-json-replace-with-fifo" ? result.packageJsonReplaceWithFifo
          : match[1] === "package-json-replace-with-socket" ? result.packageJsonReplaceWithSocket
          : match[1] === "package-json-replace-with-char-device" ? result.packageJsonReplaceWithCharDevice
          : match[1] === "package-json-replace-with-block-device" ? result.packageJsonReplaceWithBlockDevice
          : match[1] === "package-json-remove" ? result.packageJsonRemove
          : result.packageJsonReplaceWithValid;
    for (const name of names) target.add(name);
  }
  return result;
}

async function maybePauseAutoInstall(
  window: string,
  context: {
    workflows: string[];
    processed: string[];
    current: string | null;
    activeChildPid: number | null;
    loopxDir: string;
    gitignoreWorkflow?: string;
  }
): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  if (process.env.LOOPX_TEST_AUTOINSTALL_PAUSE !== window) return;
  const marker = process.env.LOOPX_TEST_AUTOINSTALL_PAUSE_MARKER;
  if (!marker) return;
  const processed = [...context.processed];
  const remaining = context.workflows.filter(
    (name) => name !== context.current && !processed.includes(name)
  );
  const payload: Record<string, unknown> = {
    window,
    processed,
    current: context.current,
    remaining,
  };
  if (context.activeChildPid !== null) {
    payload.activeChildPid = context.activeChildPid;
  }
  if (context.gitignoreWorkflow) {
    const gitignorePath = join(
      context.loopxDir,
      context.gitignoreWorkflow,
      ".gitignore"
    );
    try {
      payload.gitignoreStateAtPause = {
        exists: existsSync(gitignorePath),
      };
      if (existsSync(gitignorePath)) {
        const st = lstatSync(gitignorePath);
        if (st.isFile()) {
          payload.gitignoreStateAtPause = {
            exists: true,
            type: "regular-file",
            content: readFileSync(gitignorePath).toString("base64"),
          };
        } else if (st.isSymbolicLink()) {
          payload.gitignoreStateAtPause = { exists: true, type: "symlink" };
        } else if (st.isDirectory()) {
          payload.gitignoreStateAtPause = { exists: true, type: "directory" };
        } else if (st.isFIFO()) {
          payload.gitignoreStateAtPause = { exists: true, type: "fifo" };
        } else if (st.isSocket()) {
          payload.gitignoreStateAtPause = { exists: true, type: "socket" };
        } else {
          payload.gitignoreStateAtPause = { exists: true, type: "other" };
        }
      }
    } catch {
      payload.gitignoreStateAtPause = { exists: true, type: "other" };
    }
  }
  writeFileSync(marker, JSON.stringify(payload), "utf-8");
  if (context.activeChildPid === null) {
    const exitOnSignal = (signal: NodeJS.Signals) => {
      process.exit(signalExitCode(signal));
    };
    process.once("SIGINT", exitOnSignal);
    process.once("SIGTERM", exitOnSignal);
  }
  await new Promise<void>(() => {
    setInterval(() => {}, 1000);
  });
}

function exitIfSignaled(state: AutoInstallSignalState): void {
  if (state.abortedSignal) {
    process.exit(signalExitCode(state.abortedSignal));
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

function killProcessGroup(pid: number, signal: NodeJS.Signals | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function isNonRegularPackageJson(workflowDir: string): boolean {
  try {
    const st = lstatSync(join(workflowDir, "package.json"));
    return !st.isFile();
  } catch {
    return false;
  }
}

function applyPackageJsonFaults(
  workflowDir: string,
  workflow: string,
  fault: ReturnType<typeof getAutoInstallFault>
): void {
  const pkg = join(workflowDir, "package.json");
  if (fault.packageJsonRemove.has(workflow)) {
    rmSync(pkg, { recursive: true, force: true });
  }
  if (fault.packageJsonReplaceWithValid.has(workflow)) {
    rmSync(pkg, { recursive: true, force: true });
    writeFileSync(
      pkg,
      JSON.stringify({
        name: workflow,
        version: "1.0.0",
        dependencies: { loopx: "*" },
      })
    );
  }
  if (fault.packageJsonReplaceWithFifo.has(workflow)) {
    rmSync(pkg, { recursive: true, force: true });
    try {
      execFileSync("mkfifo", [pkg]);
    } catch {
      mkdirSync(pkg, { recursive: true });
    }
  }
  if (fault.packageJsonReplaceWithSocket.has(workflow)) {
    rmSync(pkg, { recursive: true, force: true });
    createSocketFile(pkg);
  }
  if (fault.packageJsonReplaceWithCharDevice.has(workflow)) {
    rmSync(pkg, { recursive: true, force: true });
    createDeviceFile(pkg, "char");
  }
  if (fault.packageJsonReplaceWithBlockDevice.has(workflow)) {
    rmSync(pkg, { recursive: true, force: true });
    createDeviceFile(pkg, "block");
  }
  const symlinkKind = fault.packageJsonReplaceWithSymlink.get(workflow);
  if (symlinkKind) {
    rmSync(pkg, { recursive: true, force: true });
    if (symlinkKind === "regular-file-target") {
      writeFileSync(join(workflowDir, ".package-json-target"), "{}\n");
      symlinkSync(".package-json-target", pkg);
    } else if (symlinkKind === "cycle") {
      symlinkSync("package.json", pkg);
    } else {
      symlinkSync(".missing-package-json-target", pkg);
    }
  }
}

function applyGitignoreFaultsBeforeLstat(
  workflowDir: string,
  workflow: string,
  fault: ReturnType<typeof getAutoInstallFault>
): void {
  const gitignore = join(workflowDir, ".gitignore");
  if (fault.gitignoreMakeUnreadable.has(workflow)) {
    try {
      chmodSync(gitignore, 0o000);
    } catch {
      // best effort fault setup
    }
  }
  const symlinkKind = fault.gitignoreReplaceWithSymlink.get(workflow);
  if (symlinkKind) {
    rmSync(gitignore, { recursive: true, force: true });
    if (symlinkKind === "regular-file-target") {
      writeFileSync(join(workflowDir, ".gitignore-target"), "node_modules\n");
      symlinkSync(".gitignore-target", gitignore);
    } else if (symlinkKind === "cycle") {
      writeFileSync(join(workflowDir, ".gitignore-target"), "");
      symlinkSync(".gitignore-loop", gitignore);
      symlinkSync(".gitignore-target", join(workflowDir, ".gitignore-loop"));
    } else {
      symlinkSync("does-not-exist", gitignore);
    }
  }
  if (fault.gitignoreReplaceWithSocket.has(workflow)) {
    rmSync(gitignore, { recursive: true, force: true });
    createSocketFile(gitignore);
  }
  if (fault.gitignoreReplaceWithCharDevice.has(workflow)) {
    rmSync(gitignore, { recursive: true, force: true });
    createDeviceFile(gitignore, "char");
  }
  if (fault.gitignoreReplaceWithBlockDevice.has(workflow)) {
    rmSync(gitignore, { recursive: true, force: true });
    createDeviceFile(gitignore, "block");
  }
}

function createDeviceFile(path: string, kind: "char" | "block"): void {
  try {
    execFileSync(
      "mknod",
      kind === "char" ? [path, "c", "1", "7"] : [path, "b", "7", "0"],
    );
  } catch {
    mkdirSync(path, { recursive: true });
  }
}

function createSocketFile(path: string): void {
  try {
    execFileSync("python3", ["-c", [
      "import socket, sys",
      "p=sys.argv[1]",
      "s=socket.socket(socket.AF_UNIX)",
      "s.bind(p)",
      "s.close()",
    ].join(";"), path], {
      stdio: "ignore",
    });
  } catch {
    mkdirSync(path, { recursive: true });
  }
}
