---
"loop-extender": patch
---

SPEC 3.2: workflow-level version checking now emits a dedicated "is not a regular file" warning when the entry at `.loopx/<workflow>/package.json` is non-regular (directory, symlink, FIFO, socket, or other non-regular entry).

Previously, a directory at the `package.json` path produced a misleading "is unreadable (permission denied)" warning via `readFileSync`'s `EISDIR` falling through the existing unreadable branch, and other non-regular entries (FIFO, socket, etc.) had similarly misleading category labels. The new dispatch uses `lstat` to observe the entry type before any read attempt — symlinks at the `package.json` path are not followed (per SPEC 3.2's "Symlinks at the `package.json` path are not followed" clause), so a symlink is itself a non-regular entry regardless of what the link targets.

The new warning text — `Warning: workflow '<name>' package.json is not a regular file; skipping check` — applies symmetrically to:
- the runtime workflow-version check (first entry into a workflow during a loop run)
- the install-time preflight check (`loopx install` `dependencies.loopx` validation against the source workflow)

The post-commit auto-install pass (`runAutoInstall` in `install.ts`) already had its own `lstat`-based pre-check at the entry to the auto-install dispatch; it now coexists consistently with the new runtime / preflight handling.

ENOENT (no `package.json`) remains silent — no warning fires, and execution proceeds without a version check. Other `lstat` failures (e.g., parent-directory `EACCES`) still fall through to the unreadable warning, preserving the prior contract for filesystem-permission-error cases.

The version check is skipped when this warning fires, and execution / installation proceeds — non-regular `package.json` is a non-fatal degradation of version diagnostics, not a hard error.
