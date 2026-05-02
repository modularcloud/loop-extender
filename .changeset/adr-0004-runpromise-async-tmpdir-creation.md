---
"loop-extender": patch
---

SPEC §9.2: `runPromise()` now creates `LOOPX_TMPDIR` asynchronously after returning, instead of synchronously at the call site. The tmpdir-parent snapshot (`os.tmpdir()`) and option snapshot (`snapshotOptions()`, including `cwd` defaulting) remain eager at the call site, but the actual `mkdtemp` call is deferred to a microtask after `runPromise()` has returned its Promise.

Previously, evaluating `for await (const output of gen)` inside `runPromise()` synchronously called the wrapper's `next()`, which synchronously ran the inner generator's body up to the first internal `await` — invoking `createTmpdir` before `runPromise()` had returned. Callers that synchronously inspected the tmpdir parent directory between `const p = runPromise(...)` and `await p` would observe the just-created `loopx-*` entry. The contract — "LOOPX_TMPDIR itself is created asynchronously after return, during the same pre-iteration sequence used by the CLI and run()" — is now honored. A microtask boundary (`await Promise.resolve()`) is inserted between the eager `runWithInternal()` call and the `for await` loop.
