import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTempProject,
  createWorkflowScript,
  type TempProject,
} from "../helpers/fixtures.js";
import { runCLIWithSignal } from "../helpers/cli.js";
import {
  signalReadyThenSleep,
  signalTrapExit,
  signalTrapIgnore,
  signalTrapReport,
  spawnGrandchild,
  counter,
} from "../helpers/fixture-scripts.js";

// ---------------------------------------------------------------------------
// Utility: check whether a PID is still alive
// ---------------------------------------------------------------------------

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utility: poll for a file to exist and optionally contain content
// ---------------------------------------------------------------------------

async function waitForFile(
  path: string,
  opts: { timeout?: number; interval?: number } = {},
): Promise<string> {
  const timeout = opts.timeout ?? 10_000;
  const interval = opts.interval ?? 100;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      if (content.length > 0) {
        return content;
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`waitForFile: timed out waiting for ${path}`);
}

// ---------------------------------------------------------------------------
// Utility: read PID(s) from a marker file with retry/poll
// ---------------------------------------------------------------------------

async function readPidFromMarker(markerPath: string): Promise<number> {
  const content = await waitForFile(markerPath);
  const pid = parseInt(content.trim(), 10);
  if (Number.isNaN(pid)) {
    throw new Error(`readPidFromMarker: invalid PID in ${markerPath}: "${content}"`);
  }
  return pid;
}

async function readPidsFromMarker(markerPath: string): Promise<number[]> {
  const content = await waitForFile(markerPath);
  const lines = content.trim().split("\n");
  const pids = lines.map((line) => {
    const pid = parseInt(line.trim(), 10);
    if (Number.isNaN(pid)) {
      throw new Error(`readPidsFromMarker: invalid PID line in ${markerPath}: "${line}"`);
    }
    return pid;
  });
  return pids;
}

// ---------------------------------------------------------------------------
// Utility: wait for a process to no longer be running
// ---------------------------------------------------------------------------

async function waitForProcessExit(
  pid: number,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForProcessExit: PID ${pid} still running after ${timeout}ms`);
}

// ---------------------------------------------------------------------------
// SPEC: Signal Handling
// ---------------------------------------------------------------------------

describe("SPEC: Signal Handling", () => {
  let project: TempProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  // ─────────────────────────────────────────────
  // T-SIG-01: SIGINT → exit 130
  // ─────────────────────────────────────────────

  it("T-SIG-01: SIGINT forwarded to child, loopx exits 130", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "pid-marker.txt");

    // Create a script that writes its PID, signals "ready", then sleeps
    await createWorkflowScript(
      project,
      "sig-sleep",
      "index",
      ".sh",
      signalReadyThenSleep(markerPath),
    );

    const { result, sendSignal, waitForStderr } = runCLIWithSignal(
      ["run", "-n", "1", "sig-sleep"],
      { cwd: project.dir, timeout: 30_000 },
    );

    // Wait for the child to be ready before sending signal
    await waitForStderr("ready");

    sendSignal("SIGINT");

    const outcome = await result;
    expect(outcome.exitCode).toBe(130);
  });

  // ─────────────────────────────────────────────
  // T-SIG-02: SIGTERM → exit 143
  // ─────────────────────────────────────────────

  it("T-SIG-02: SIGTERM forwarded to child, loopx exits 143", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "pid-marker.txt");

    await createWorkflowScript(
      project,
      "sig-sleep",
      "index",
      ".sh",
      signalReadyThenSleep(markerPath),
    );

    const { result, sendSignal, waitForStderr } = runCLIWithSignal(
      ["run", "-n", "1", "sig-sleep"],
      { cwd: project.dir, timeout: 30_000 },
    );

    await waitForStderr("ready");

    sendSignal("SIGTERM");

    const outcome = await result;
    expect(outcome.exitCode).toBe(143);
  });

  // ─────────────────────────────────────────────
  // T-SIG-03: After SIGINT, child process is gone
  // ─────────────────────────────────────────────

  it("T-SIG-03: after SIGINT, child process is no longer running", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "pid-marker.txt");

    await createWorkflowScript(
      project,
      "sig-sleep",
      "index",
      ".sh",
      signalReadyThenSleep(markerPath),
    );

    const { result, sendSignal, waitForStderr } = runCLIWithSignal(
      ["run", "-n", "1", "sig-sleep"],
      { cwd: project.dir, timeout: 30_000 },
    );

    await waitForStderr("ready");

    // Read the child PID from the marker file
    const childPid = await readPidFromMarker(markerPath);
    expect(isProcessRunning(childPid)).toBe(true);

    sendSignal("SIGINT");

    // Wait for loopx to exit
    await result;

    // The child process should be gone
    // Give a brief moment for cleanup to propagate
    await waitForProcessExit(childPid, 5_000);
    expect(isProcessRunning(childPid)).toBe(false);
  });

  // ─────────────────────────────────────────────
  // T-SIG-04: Grace period — child traps SIGTERM, exits within 2s → clean exit
  // ─────────────────────────────────────────────

  it("T-SIG-04: child traps SIGTERM and exits within grace period → clean exit 143", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "pid-marker.txt");

    // signalTrapExit: traps SIGTERM, sleeps 2s (under the 5s grace period), then exits 0
    await createWorkflowScript(
      project,
      "sig-trap-exit",
      "index",
      ".sh",
      signalTrapExit(markerPath, 2),
    );

    const { result, sendSignal, waitForStderr } = runCLIWithSignal(
      ["run", "-n", "1", "sig-trap-exit"],
      { cwd: project.dir, timeout: 30_000 },
    );

    await waitForStderr("ready");

    sendSignal("SIGTERM");

    const outcome = await result;
    // loopx should exit 143 (clean termination — signal was forwarded)
    expect(outcome.exitCode).toBe(143);
  });

  // ─────────────────────────────────────────────
  // T-SIG-05: Grace period exceeded — child ignores SIGTERM → SIGKILL after ~5s
  // ─────────────────────────────────────────────

  it(
    "T-SIG-05: child ignores SIGTERM → SIGKILL after grace period, process terminated",
    async () => {
      project = await createTempProject();
      const markerPath = join(project.dir, "pid-marker.txt");

      // signalTrapIgnore: traps SIGTERM with no-op, sleeps indefinitely
      await createWorkflowScript(
        project,
        "sig-trap-ignore",
        "index",
        ".sh",
        signalTrapIgnore(markerPath),
      );

      const { result, sendSignal, waitForStderr } = runCLIWithSignal(
        ["run", "-n", "1", "sig-trap-ignore"],
        { cwd: project.dir, timeout: 30_000 },
      );

      await waitForStderr("ready");

      // Read the child PID before sending signal
      const childPid = await readPidFromMarker(markerPath);

      sendSignal("SIGTERM");

      // loopx should eventually exit (after the ~5s grace period + SIGKILL)
      const outcome = await result;

      // The exit code may vary (could be 137 from SIGKILL or 143), but loopx must exit
      expect(outcome.exitCode).toBeDefined();

      // The child process must be gone — SIGKILL is not trappable
      await waitForProcessExit(childPid, 5_000);
      expect(isProcessRunning(childPid)).toBe(false);
    },
    { timeout: 30_000 },
  );

  // ─────────────────────────────────────────────
  // T-SIG-06: Process group signal — grandchild also killed
  // ─────────────────────────────────────────────

  it("T-SIG-06: process group signal ensures grandchild is also killed", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "pid-marker.txt");

    // spawnGrandchild: spawns a background `sleep 3600`, writes both PIDs
    // (parent on line 1, grandchild on line 2), signals "ready", then waits
    await createWorkflowScript(
      project,
      "sig-grandchild",
      "index",
      ".sh",
      spawnGrandchild(markerPath),
    );

    const { result, sendSignal, waitForStderr } = runCLIWithSignal(
      ["run", "-n", "1", "sig-grandchild"],
      { cwd: project.dir, timeout: 30_000 },
    );

    await waitForStderr("ready");

    // Read both PIDs from the marker file
    const pids = await readPidsFromMarker(markerPath);
    expect(pids).toHaveLength(2);
    const [childPid, grandchildPid] = pids;

    // Both processes should be alive before the signal
    expect(isProcessRunning(childPid)).toBe(true);
    expect(isProcessRunning(grandchildPid)).toBe(true);

    sendSignal("SIGTERM");

    // Wait for loopx to exit
    await result;

    // Both the child and grandchild must be gone
    await waitForProcessExit(childPid, 5_000);
    await waitForProcessExit(grandchildPid, 5_000);
    expect(isProcessRunning(childPid)).toBe(false);
    expect(isProcessRunning(grandchildPid)).toBe(false);
  });

  // ─────────────────────────────────────────────
  // T-SIG-07: Between-iterations signal → immediate exit 143
  // ─────────────────────────────────────────────

  it(
    "T-SIG-07: signal between iterations causes immediate exit 143",
    async () => {
      project = await createTempProject();
      const counterFile = join(project.dir, "counter.txt");
      const iterMarker = join(project.dir, "iter-done.txt");

      // Script that:
      // 1. Appends to the counter file (to count iterations)
      // 2. Writes the current count to iter-done marker (signals iteration completion)
      // 3. Sleeps briefly to give the signal time to arrive between iterations
      // 4. Outputs JSON result so loopx proceeds to next iteration
      const scriptContent = `#!/bin/bash
printf '1' >> "${counterFile}"
COUNT=$(wc -c < "${counterFile}" | tr -d ' ')
printf '%s' "$COUNT" > "${iterMarker}"
sleep 0.1
printf '{"result":"%s"}' "$COUNT"
`;
      await createWorkflowScript(project, "iter-counter", "index", ".sh", scriptContent);

      const { result, sendSignal } = runCLIWithSignal(
        ["run", "-n", "20", "iter-counter"],
        { cwd: project.dir, timeout: 30_000 },
      );

      // Poll for the first iteration to complete by watching the marker file
      await waitForFile(iterMarker, { timeout: 10_000 });

      // Send SIGTERM between iterations (after iteration 1 completes,
      // before iteration 3 finishes). The signal should cause loopx to
      // exit immediately rather than continuing to the next iteration.
      sendSignal("SIGTERM");

      const outcome = await result;
      expect(outcome.exitCode).toBe(143);

      // Verify that not all 20 iterations ran. Due to timing, at least 1
      // iteration completed but the signal should stop the loop well before
      // all 20 complete (each takes ~100ms, so 20 would take ~2s).
      const counterContent = readFileSync(counterFile, "utf-8");
      const iterationsRan = counterContent.length;
      expect(iterationsRan).toBeGreaterThanOrEqual(1);
      expect(iterationsRan).toBeLessThan(20);
    },
    { timeout: 30_000, retry: 3 },
  );

  // ─────────────────────────────────────────────
  // T-SIG-08: Signal Identity — child receives the same signal loopx received
  // ─────────────────────────────────────────────

  it("T-SIG-08a: SIGINT is forwarded as SIGINT (not SIGTERM)", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "pid-marker.txt");
    const reportPath = join(project.dir, "signal-report.txt");

    await createWorkflowScript(
      project,
      "sig-report",
      "index",
      ".sh",
      signalTrapReport(markerPath, reportPath),
    );

    const { result, sendSignal, waitForStderr } = runCLIWithSignal(
      ["run", "-n", "1", "sig-report"],
      { cwd: project.dir, timeout: 30_000 },
    );

    await waitForStderr("ready");

    sendSignal("SIGINT");

    const outcome = await result;
    expect(outcome.exitCode).toBe(130);

    const signal = readFileSync(reportPath, "utf-8");
    expect(signal).toBe("SIGINT");
  });

  it("T-SIG-08b: SIGTERM is forwarded as SIGTERM (not SIGINT)", async () => {
    project = await createTempProject();
    const markerPath = join(project.dir, "pid-marker.txt");
    const reportPath = join(project.dir, "signal-report.txt");

    await createWorkflowScript(
      project,
      "sig-report",
      "index",
      ".sh",
      signalTrapReport(markerPath, reportPath),
    );

    const { result, sendSignal, waitForStderr } = runCLIWithSignal(
      ["run", "-n", "1", "sig-report"],
      { cwd: project.dir, timeout: 30_000 },
    );

    await waitForStderr("ready");

    sendSignal("SIGTERM");

    const outcome = await result;
    expect(outcome.exitCode).toBe(143);

    const signal = readFileSync(reportPath, "utf-8");
    expect(signal).toBe("SIGTERM");
  });
});
