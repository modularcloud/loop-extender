import {
  mkdtempSync,
  lstatSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  chmodSync,
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
 * Create the run-scoped tmpdir under `parent` per SPEC §7.4 creation order.
 * Throws on failure with the original error preserved (cleanup of any
 * partial directory does not mask the creation error).
 */
export function createTmpdir(parent: string): TmpdirResource {
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
    cleanupTmpdir(resource, state);
    throw new Error(
      `LOOPX_TMPDIR creation failed: mode securing failed: EACCES`
    );
  }

  try {
    chmodSync(path, 0o700);
  } catch (err: unknown) {
    const state = newCleanupState();
    cleanupTmpdir(resource, state);
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
export function cleanupTmpdir(
  resource: TmpdirResource,
  state: CleanupState
): void {
  if (state.attempted) return;
  state.attempted = true;

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
