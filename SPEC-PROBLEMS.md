# SPEC-PROBLEMS

Open ADR-0004-scoped problems in `SPEC.md` that prevent `TEST-SPEC.md` from cleanly covering observed behavior. Each entry documents an ambiguity, gap, or under-specified clause to be resolved by a follow-up SPEC clarification cycle. Resolved entries are removed from this file; if no entries remain, this file is deleted.

ID convention: `P-<adr>-<seq>` where `<adr>` is the ADR number (e.g., `0004`) and `<seq>` continues the per-ADR sequence (P-0004-01 through P-0004-09 were opened and resolved in prior cycles; new entries start at P-0004-10).

---

## P-0004-10: `.gitignore` safeguard `lstat`-failure no-mutation guarantee

**Status:** Open

**Scope:** ADR-0004 (auto-install workflow dependencies — SPEC §10.10 `.gitignore` safeguard).

**Problem.** SPEC §10.10 enumerates two structurally distinct safeguard-failure branches with asymmetric explicit-no-mutation wording:

- **Non-regular branch** (directory, symlink, FIFO, socket, or other non-regular entry): "loopx treats this as a `.gitignore` safeguard failure. **The entry is left unchanged**, `npm install` is skipped for that workflow, the failure is recorded in the auto-install aggregate report, loopx proceeds to the next workflow, and the failure contributes to final exit code `1`."
- **`lstat`-failure branch** (`lstat` failure other than `ENOENT`, or a write failure when synthesizing `.gitignore`): "loopx treats this as a `.gitignore` safeguard failure under the same aggregate-report / skip-`npm install` semantics."

The non-regular branch explicitly preserves the entry; the `lstat`-failure branch is silent on whether loopx may further mutate the `.gitignore` path after the failure is recorded. The natural reading — and the parallel of the explicit no-mutation guarantee for the `LOOPX_TMPDIR` cleanup-safety `lstat`-failure clause in §7.4 — is that loopx makes no further changes to the path after recording the safeguard failure, but this is implicit rather than normative.

**Why this matters for TEST-SPEC.md.** `T-INST-112h` (no `.gitignore` exists; `lstat` returns non-`ENOENT` error) asserts that no `.gitignore` is created on disk for failing workflows. `T-INST-112n` (a regular `.gitignore` already exists; `lstat` returns non-`ENOENT` error) asserts that the pre-existing regular `.gitignore` is byte-identical and that its mode bits are unchanged from the seam-set value. Both tests encode a "make no further changes" reading that goes beyond what SPEC §10.10 literally requires. A conforming implementation that records the safeguard failure, skips `npm install`, and aggregates the failure could plausibly also (a) attempt a recovery write of `node_modules` into a partial `.gitignore` after observing the `lstat` failure, or (b) chmod the entry as part of a "restore readable for diagnostic purposes" path, while still satisfying every literal SPEC clause — and would fail the existing TEST-SPEC.md assertions without violating SPEC text.

**Resolution paths.**

- **Resolution A (preferred — ratify natural reading):** Amend SPEC §10.10's `lstat`-failure / write-failure bullet to add explicit no-further-mutation wording, e.g.: "loopx treats this as a `.gitignore` safeguard failure under the same aggregate-report / skip-`npm install` semantics, **and makes no further changes to the `.gitignore` path** for that workflow." With this clarification, `T-INST-112h` and `T-INST-112n` are direct conformance pins.
- **Resolution B (loosen tests):** If the SPEC intent is to allow further mutation on the `lstat`-failure branch, loosen `T-INST-112h` and `T-INST-112n` to assert only exit code, aggregate-report content, and skip-`npm install` — dropping the no-creation assertion for the absent-entry case and the byte-identity / mode-preservation assertions for the present-entry case.

The Resolution A reading is consistent with how `LOOPX_TMPDIR` cleanup-safety handles its analogous `lstat` / `unlink` / `recursive-removal` failures ("emits a single stderr warning and **makes no further changes**", §7.4) and is the simpler implementation profile.

---

## P-0004-11: Auto-install `package.json` validation timing — committed-state vs. cached preflight result

**Status:** Open

**Scope:** ADR-0004 (auto-install workflow dependencies — SPEC §3.2 workflow `package.json` failure modes × SPEC §10.10 malformed-`package.json` skip).

**Problem.** SPEC §3.2 says: "Each workflow's `package.json` is checked once during the install operation. Warnings are emitted once per affected workflow." SPEC §10.10's malformed-`package.json` clause says: "When the workflow's `package.json` is unreadable, contains invalid JSON, has an invalid `loopx` semver range, or is at a non-regular path … the existing section 3.2 warning is emitted and auto-install **skips that workflow silently** — loopx does not invoke `npm install` against a file that failed version validation and does not add a second warning for the same underlying failure."

Neither clause specifies *when* during the install operation the single check happens, and the "single check + no second warning" wording is consistent with at least two distinct conforming implementation profiles:

- **Profile I (re-read at auto-install dispatch):** The single check happens at the post-commit auto-install dispatch — the dispatch `lstat`s and (if regular) reads / parses the committed `package.json` for each workflow, emits the §3.2 warning if malformed, and skips. Preflight uses a different mechanism (e.g., a separate version-mismatch check that reads the source-side `package.json` before commit) for its blocking-error decisions.
- **Profile II (cached preflight result):** The single check happens at preflight — the preflight reads / parses the source-side or committed `package.json`, caches a per-workflow validation outcome, and emits the §3.2 warning at preflight time. The post-commit auto-install dispatch consults the cached outcome and skips workflows whose cached state is malformed without re-reading the file.

Both profiles satisfy "checked once" and "no second warning". They diverge observably when the committed `package.json` mutates between the preflight check and the auto-install dispatch.

**Why this matters for TEST-SPEC.md.** `T-INST-113i`, `T-INST-113j`, and `T-INST-113k` use the section 1.4 `package-json-replace-with-{symlink,fifo,socket}:<workflow>` seams, which replace the committed `package.json` with a non-regular entry **after the commit phase and before the per-workflow auto-install dispatch**. The tests assert that auto-install observes the post-commit replacement and skips silently. Under Profile I (re-read), the tests pass; under Profile II (cached), the cached "regular file" outcome would route the dispatch through normal `npm install`, and the tests would fail despite the implementation being SPEC-conforming.

The seam's design implicitly assumes Profile I. SPEC §3.2 / §10.10 do not require either profile.

**Resolution paths.**

- **Resolution A (re-read at auto-install dispatch):** Add explicit wording to SPEC §10.10's "Malformed `package.json`" bullet stating that the auto-install dispatch evaluates the committed `package.json`'s state at the time of the post-commit auto-install pass (not a cached preflight result), and reconcile §3.2's "checked once" with the post-commit re-read by clarifying that the §3.2 single-check / single-warning rule is scoped to runtime version-mismatch warnings (which are first-entry deduped per existing §3.2 wording) and that install-time checks may run more than once per `package.json` provided that warnings are still emitted at most once per affected workflow per install operation. With this clarification, `T-INST-113i` / `T-INST-113j` / `T-INST-113k` are direct conformance pins on the post-commit re-read contract.
- **Resolution B (cached preflight allowed):** Add explicit wording to SPEC §10.10's "Malformed `package.json`" bullet stating that auto-install dispatch may use a preflight-cached validation result, and revise the section 1.4 `package-json-replace-with-{symlink,fifo,socket}:<workflow>` seams (and the dependent tests) to inject into the validation-result cache rather than the committed file path. Without that revision, the existing tests over-constrain Profile II implementations.

Resolution A is consistent with how the `.gitignore` safeguard's `lstat` dispatch is specified (per-workflow re-evaluation immediately before `npm install`); Resolution B aligns with a stricter "checked once" reading of §3.2 but requires more SPEC and seam changes.
