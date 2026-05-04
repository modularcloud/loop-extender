import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";

// TEST-SPEC §1.4 — `LOOPX_TEST_TERMINAL_TRIGGER_PAUSE` seam.
//
// Window-named pauses inside the run lifecycle that let a parent harness
// race a second terminal trigger into a known window. Each window has its
// own callsite (`cleanup-start` inside cleanupTmpdir, `consumer-throw-
// observed` inside the wrapper.throw, etc.); this module hosts the shared
// marker-write + bounded-sleep mechanic so every window honors the same
// ordering contract (marker visibility implies the bounded delay is about
// to start) and the same delay envelope (~3s, within the §1.4 [2s, 10s]
// range).

function inTestMode(): boolean {
  return process.env.NODE_ENV === "test";
}

function asyncSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pause the current async path for the bounded TEST-SPEC §1.4 interval when
 * `NODE_ENV=test` and `LOOPX_TEST_TERMINAL_TRIGGER_PAUSE` equals
 * `expectedWindow`. The pause is preceded by a best-effort UTF-8 JSON marker
 * write to the path named by `LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER` (when
 * set); marker visibility implies the bounded delay is about to start, per
 * the §1.4 ordering contract.
 *
 * No-op when not in test mode, when the env var is unset / empty, or when
 * the configured window does not match `expectedWindow`. Marker write is
 * best-effort: if the marker path is unwritable, the pause still happens.
 */
export async function maybePauseAtTerminalTriggerWindow(
  expectedWindow: string
): Promise<void> {
  if (!inTestMode()) return;
  const window = process.env.LOOPX_TEST_TERMINAL_TRIGGER_PAUSE;
  if (window !== expectedWindow) return;

  const markerPath = process.env.LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER;
  if (markerPath) {
    try {
      const fd = openSync(markerPath, "w");
      try {
        const payload = JSON.stringify({ window: expectedWindow });
        writeSync(fd, Buffer.from(payload + "\n", "utf-8"));
        try {
          fsyncSync(fd);
        } catch {
          // fsync may not be supported on every backing fs; the marker is
          // already on the kernel's write buffer and the bounded delay
          // gives the harness ample time to observe it.
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // Marker write is best-effort. If it fails (unwritable path, etc.),
      // we still pause so the seam contract holds at the pause-only level.
    }
  }

  // Bounded delay: ≥ 2 seconds, ≤ 10 seconds (TEST-SPEC §1.4). Three
  // seconds is enough for parent polling + signal / abort delivery on a
  // busy CI host while keeping suite runtime tight.
  await asyncSleep(3000);
}
