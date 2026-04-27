# SPEC Problems

Open SPEC ambiguities, gaps, and under-specified clauses that prevent TEST-SPEC.md from cleanly covering ADR-0004 behavior. Each entry is scoped to ADR-0004 and is intended to be resolved in a follow-up cycle by amending SPEC.md.

## ADR-0004

### `RunOptions.env` Proxy `get` trap semantics during snapshot

**Status:** open.

**Scope:** ADR-0004 (`RunOptions.env` snapshot in SPEC §9.1 / §9.2 / §9.5).

**Problem.** SPEC §9.5 specifies that `RunOptions.env` "Entries are captured synchronously at call time as a shallow copy — loopx reads the supplied object's own enumerable string-keyed properties once," and explicitly enumerates three snapshot-time-throw paths captured via the standard pre-iteration error path:

- `Proxy` `ownKeys` traps that throw,
- throwing enumerable getters (e.g., via `Object.defineProperty(env, key, { enumerable: true, get() { throw … } })`),
- throwing `options.env` getters on the options object itself.

SPEC does **not** explicitly say whether the snapshot must read enumerable string-keyed values via ordinary property `[[Get]]` semantics (such that a Proxy `get` trap installed on `options.env` is invoked once per included key during the snapshot), or whether descriptor-based extraction (e.g., reading `Object.getOwnPropertyDescriptor(env, key).value` directly, which delegates to the proxy's `getOwnPropertyDescriptor` trap and reads from the target's own descriptor without invoking the proxy's `get` trap) is also conforming.

This matters because the two extraction strategies produce observably different behavior on a `Proxy` whose `get` trap throws or counts: under `[[Get]]`-based extraction the trap fires (or throws) once per included key; under descriptor-based extraction the trap is never invoked. SPEC §9.5's enumeration of snapshot-time-throw paths covers `ownKeys` (always invoked during enumeration regardless of extraction strategy), throwing enumerable getters (which fire under both strategies because `Object.defineProperty`-installed getters are part of the descriptor's `get` slot, invoked when the descriptor's value is read), and the outer `options.env` getter (which fires before any inner extraction strategy is chosen). It does not enumerate the Proxy `get` trap, leaving the contract ambiguous on this axis.

**Effect on TEST-SPEC.md.** Tests that rely on the Proxy `get` trap firing during the snapshot — both the throwing-trap surfacing tests (T-API-62f3) and the no-retry counter tests (T-API-62h9) and the read-once counter assertions on the value-read axis in T-API-52e / T-API-52e2 variant (b) — over-pin behavior SPEC does not actually require. Until this clause is clarified, those tests have been relaxed to observational status (they pass under either extraction strategy and characterize implementation behavior without claiming a SPEC-mandated outcome on the Proxy `get` axis). T-API-62f2 already takes this observational form for the analogous `getOwnPropertyDescriptor` trap ambiguity.

**Possible resolutions.**

1. Amend SPEC §9.5 to specify that the snapshot reads enumerable string-keyed values via ordinary property `[[Get]]` semantics, such that a Proxy `get` trap is invoked exactly once per included key during the snapshot (and a throwing trap is captured / surfaced via the standard pre-iteration error path). This would re-strictify the affected tests.
2. Amend SPEC §9.5 to explicitly leave the value-read strategy implementation-defined (with a non-normative note that descriptor-based extraction is also conforming), making the current observational treatment normative.

Either resolution closes the ambiguity; option 1 matches the existing precedent of pinning down snapshot-time throws explicitly, option 2 matches the precedent set for the descriptor-trap axis (T-API-62f2).
