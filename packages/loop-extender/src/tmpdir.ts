import {
  mkdtempSync,
  lstatSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  chmodSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";

// SPEC §7.4 — Run-scoped temporary directory (`LOOPX_TMPDIR`).
//
// Creation order (normative): mkdtemp → identity capture → mode securing.
// Cleanup dispatches on lstat: ENOENT no-op, symlink unlink, non-directory
// leave-with-warning, identity-match recursive remove, identity-mismatch
// leave-with-warning. Idempotent — at most one cleanup attempt and at most
// one stderr warning per resource over the lifetime of the run.
//
// Test seams (TEST-SPEC §1.4, NODE_ENV=test only):
//   - LOOPX_TEST_TMPDIR_FAULT={identity-capture-fail,
//                              identity-capture-fail-rmdir-fail,
//                              mode-secure-fail}
//   - LOOPX_TEST_CLEANUP_FAULT={lstat-fail,symlink-unlink-fail,
//                               recursive-remove-fail}
//   - LOOPX_TEST_TERMINAL_TRIGGER_PAUSE=cleanup-start
//     LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER=<absolute-path>
//     Pauses cleanup at entry for a bounded interval after writing a
//     parent-observable JSON marker, so the harness can deliver a racing
//     terminal trigger and assert SPEC §7.2 first-observed-wins +
//     cleanup-idempotence + at-most-one-warning.

export interface TmpdirIdentity {
  dev: bigint;
  ino: bigint;
}

export interface TmpdirResource {
  path: string;
  identity: TmpdirIdentity;
}

export interface CleanupState {
  attempted: boolean;
  warned: boolean;
}

export function newCleanupState(): CleanupState {
  return { attempted: false, warned: false };
}

function inTestMode(): boolean {
  return process.env.NODE_ENV === "test";
}

function readFaults(envVar: string): Set<string> {
  if (!inTestMode()) return new Set();
  const v = process.env[envVar];
  if (!v) return new Set();
  return new Set(
    v
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function emitCleanupWarning(state: CleanupState, payload: string): void {
  if (state.warned) return;
  state.warned = true;
  process.stderr.write(`Warning: LOOPX_TMPDIR cleanup: ${payload}\n`);
  if (inTestMode()) {
    process.stderr.write(`LOOPX_TEST_CLEANUP_WARNING\t${payload}\n`);
  }
}

/**
 * Asynchronous bounded sleep — yields the event loop for `ms` milliseconds.
 *
 * Used by the `cleanup-start` seam to inject a deterministic pause window the
 * harness can race a second terminal trigger into. The pause is intentionally
 * non-blocking so a same-process driver (programmatic API tests) can poll for
 * the parent-observable marker and call `gen.return()` / `gen.throw()` /
 * `ac.abort()` mid-pause. For the cross-process CLI tests the asynchronous
 * pause is observably equivalent to a synchronous one — the OS-level signal
 * handler still queues second-signal observation regardless.
 */
function asyncSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TEST-SPEC §1.4 `LOOPX_TEST_TERMINAL_TRIGGER_PAUSE=cleanup-start` seam.
 *
 * Fires at the entry of `cleanupTmpdir` (before any `lstat` / `unlink` /
 * `rmSync` call). When `NODE_ENV=test` and the env var equals `cleanup-start`,
 * writes a UTF-8 JSON marker file (when the companion
 * `LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER` env var names an absolute path),
 * `fsync`s and closes the file, then pauses for a bounded interval — long
 * enough for the harness to race a second terminal trigger in, short enough to
 * bound test runtime if no trigger arrives.
 */
async function maybePauseAtCleanupStart(): Promise<void> {
  if (!inTestMode()) return;
  const window = process.env.LOOPX_TEST_TERMINAL_TRIGGER_PAUSE;
  if (window !== "cleanup-start") return;

  const markerPath = process.env.LOOPX_TEST_TERMINAL_TRIGGER_PAUSE_MARKER;
  if (markerPath) {
    try {
      const fd = openSync(markerPath, "w");
      try {
        const payload = JSON.stringify({ window: "cleanup-start" });
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

  // Bounded delay: ≥ 2 seconds, ≤ 10 seconds (TEST-SPEC §1.4). Three seconds
  // is enough for parent polling + signal delivery on a busy CI host while
  // keeping suite runtime tight.
  await asyncSleep(3000);
}

/**
 * Create the run-scoped tmpdir under `parent` per SPEC §7.4 creation order.
 * Throws on failure with the original error preserved (cleanup of any
 * partial directory does not mask the creation error).
 */
export async function createTmpdir(parent: string): Promise<TmpdirResource> {
  const tmpdirFaults = readFaults("LOOPX_TEST_TMPDIR_FAULT");

  // Sub-step 1: mkdtemp. If this fails the path doesn't exist and no
  // cleanup is needed.
  const path = mkdtempSync(join(parent, "loopx-"));

  // Sub-step 2: capture identity fingerprint.
  if (
    tmpdirFaults.has("identity-capture-fail") ||
    tmpdirFaults.has("identity-capture-fail-rmdir-fail")
  ) {
    // Per SPEC §7.4, attempt a single non-recursive rmdir on the path.
    // Use a fresh cleanup-state so the warning cardinality applies to this
    // creation-failure attempt independently of any later terminal cleanup.
    const state = newCleanupState();
    state.attempted = true;
    if (tmpdirFaults.has("identity-capture-fail-rmdir-fail")) {
      emitCleanupWarning(
        state,
        `failed to remove ${path} after identity-capture failure: EACCES`
      );
    } else {
      try {
        rmdirSync(path);
      } catch (err: unknown) {
        emitCleanupWarning(
          state,
          `failed to remove ${path} after identity-capture failure: ${
            (err as Error).message
          }`
        );
      }
    }
    // Original creation error (SPEC §7.4 "does not mask the original
    // creation error").
    throw new Error(
      `LOOPX_TMPDIR creation failed: identity capture failed: EACCES`
    );
  }

  let stat: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint };
  try {
    stat = lstatSync(path, { bigint: true }) as typeof stat;
  } catch (err: unknown) {
    const state = newCleanupState();
    state.attempted = true;
    try {
      rmdirSync(path);
    } catch (err2: unknown) {
      emitCleanupWarning(
        state,
        `failed to remove ${path} after identity-capture failure: ${
          (err2 as Error).message
        }`
      );
    }
    throw new Error(
      `LOOPX_TMPDIR creation failed: identity capture failed: ${
        (err as Error).message
      }`
    );
  }

  const identity: TmpdirIdentity = { dev: stat.dev, ino: stat.ino };
  const resource: TmpdirResource = { path, identity };

  // Sub-step 3: secure mode 0700.
  if (tmpdirFaults.has("mode-secure-fail")) {
    // Per SPEC §7.4, run the FULL identity-fingerprint cleanup-safety
    // routine on the partial directory.
    const state = newCleanupState();
    await cleanupTmpdir(resource, state);
    throw new Error(
      `LOOPX_TMPDIR creation failed: mode securing failed: EACCES`
    );
  }

  try {
    chmodSync(path, 0o700);
  } catch (err: unknown) {
    const state = newCleanupState();
    await cleanupTmpdir(resource, state);
    throw new Error(
      `LOOPX_TMPDIR creation failed: mode securing failed: ${
        (err as Error).message
      }`
    );
  }

  return resource;
}

/**
 * Clean up a previously created tmpdir per SPEC §7.4. Idempotent: subsequent
 * calls with the same `state` are no-ops. Emits at most one stderr warning
 * per state over the lifetime of the cleanup.
 */
export async function cleanupTmpdir(
  resource: TmpdirResource,
  state: CleanupState
): Promise<void> {
  if (state.attempted) return;
  state.attempted = true;

  // TEST-SPEC §1.4: pause at cleanup entry when the seam is configured. Done
  // BEFORE any cleanup work so the harness can race a second terminal trigger
  // in while loopx is paused; cleanup proceeds afterward.
  await maybePauseAtCleanupStart();

  const { path, identity } = resource;
  const cleanupFaults = readFaults("LOOPX_TEST_CLEANUP_FAULT");

  // Top-level lstat. Test seam: lstat-fail.
  if (cleanupFaults.has("lstat-fail")) {
    emitCleanupWarning(
      state,
      `cleanup of ${path} aborted: lstat failed: EACCES`
    );
    return;
  }

  let stat: ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint };
  try {
    stat = lstatSync(path, { bigint: true }) as typeof stat;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      // Case 1: ENOENT — no-op.
      return;
    }
    emitCleanupWarning(
      state,
      `cleanup of ${path} aborted: lstat failed: ${e?.message ?? String(err)}`
    );
    return;
  }

  // Case 2: symlink — unlink (do not follow).
  if (stat.isSymbolicLink()) {
    if (cleanupFaults.has("symlink-unlink-fail")) {
      emitCleanupWarning(
        state,
        `cleanup of ${path} aborted: unlink symlink failed: EACCES`
      );
      return;
    }
    try {
      unlinkSync(path);
    } catch (err: unknown) {
      emitCleanupWarning(
        state,
        `cleanup of ${path} aborted: unlink symlink failed: ${
          (err as Error).message
        }`
      );
    }
    return;
  }

  // Case 3: non-directory non-symlink — leave with warning.
  if (!stat.isDirectory()) {
    emitCleanupWarning(
      state,
      `cleanup of ${path} skipped: not a directory or symlink`
    );
    return;
  }

  // Cases 4 & 5: directory — identity-match check.
  if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
    // Case 5: identity mismatch — leave with warning.
    emitCleanupWarning(
      state,
      `cleanup of ${path} skipped: identity mismatch`
    );
    return;
  }

  // Case 4: recursive remove.
  if (cleanupFaults.has("recursive-remove-fail")) {
    emitCleanupWarning(
      state,
      `cleanup of ${path} aborted: recursive remove failed: EACCES`
    );
    return;
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err: unknown) {
    emitCleanupWarning(
      state,
      `cleanup of ${path} aborted: recursive remove failed: ${
        (err as Error).message
      }`
    );
  }
}
