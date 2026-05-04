---
"loop-extender": minor
---

ADR-0004 §7.4: scripts now receive a per-run `LOOPX_TMPDIR` protocol-injected environment variable pointing at a freshly-created temporary directory, and loopx automatically cleans it up on every terminal outcome (normal completion, script error, invalid `goto`, abort, signal, consumer cancellation).

Per SPEC §7.4, the directory is created via `mkdtemp(<os.tmpdir()>/loopx-)` with mode `0700` and an identity fingerprint captured for cleanup safety. The same value is injected into every spawned script in the run (starting target, intra- and cross-workflow `goto`, loop reset). Files written there persist within the run and are removed when loopx exits.

Cleanup is identity-fingerprint-matched and best-effort — a recorded `LOOPX_TMPDIR` whose `lstat` no longer matches what loopx created (renamed, replaced, or different inode) is left in place with a single stderr warning rather than recursively removed. Cleanup runs at most once per resource and emits at most one warning regardless of how many terminal triggers race.

**For workflow scripts**: read `$LOOPX_TMPDIR` (Bash) or `process.env.LOOPX_TMPDIR` (JS/TS) for a writable scratch location that is guaranteed to exist for the duration of the run and to be cleaned up afterwards. Use this for cross-workflow `goto` rendezvous data or any per-run temp state.
