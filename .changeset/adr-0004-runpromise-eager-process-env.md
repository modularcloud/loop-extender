---
"loop-extender": patch
---

SPEC §9.2: `runPromise()` now eagerly snapshots `process.env` and the global env-file path (`XDG_CONFIG_HOME` / `HOME`-derived) synchronously at the call site, before the returned Promise. Mutations to `process.env` after `runPromise()` returns are no longer observed by spawned scripts within that run. The same eager schedule already applied to the tmpdir-parent snapshot (`os.tmpdir()`) and the options object; it now extends to the inherited environment.

`run()` retains its lazy semantics per SPEC §9.1: the inherited `process.env` snapshot is captured on the first `next()` call. Mutations between `run()` returning and first `next()` are observed; later mutations across iterations are not (the snapshot is reused once taken).

Internally, `mergeEnv()` and `getGlobalEnvPath()` / `loadGlobalEnv()` accept optional snapshot/path parameters; when `runPromise()` provides them, the live `process.env` is bypassed for the entire run.
