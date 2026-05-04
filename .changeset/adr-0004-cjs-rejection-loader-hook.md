---
"loop-extender": patch
---

SPEC §6.3 CommonJS rejection now applies uniformly across all four JS/TS script extensions (`.js`, `.ts`, `.tsx`, `.jsx`). Previously, scripts using `module.exports = X` or `exports.foo = X` in a `.ts`/`.tsx`/`.jsx` workflow file silently ran on Node — defeating the SPEC §6.3 contract that CommonJS syntax must fail at execution time.

The loopx custom loader-hook now intercepts `.ts`/`.tsx`/`.jsx` files in `.loopx/` directories, transforms them via esbuild (TS types stripped, JSX expanded to `React.createElement` per the existing classic-transform contract) without enabling esbuild's CJS-shim wrapper, and feeds the result to Node as a true ES module. Any reference to `module`, `exports`, or `require` then throws `ReferenceError` at evaluation time.

`require()` rejection was already enforced for all four extensions (`.js` via the existing loader-hook ESM force; `.ts`/`.tsx`/`.jsx` via the auto-injected `.loopx/package.json {"type":"module"}` from `bin-path.ts` and Bun's `--define require:null`).

`esbuild` is now declared as an explicit runtime dependency of `loop-extender` (previously transitive via `tsx`).

This affects only workflow scripts that contained CommonJS syntax — those scripts now fail at execution time as the SPEC requires. Workflow scripts using ESM syntax (`import` / `export`) continue to work unchanged.
