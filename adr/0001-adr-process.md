# ADR-0001: Establish ADR Process

**Status:** Implemented

---

## Context

As the loopx project grows, we need a structured way to propose, evaluate, and track changes to the specification. Without a formal process, spec changes risk being ad-hoc, poorly documented, or inconsistently applied through the development lifecycle.

## Decision

We adopt an Architecture Decision Record (ADR) process to govern all changes to the loopx specification (`SPEC.md`). Each ADR describes a proposed modification to the spec and progresses through a defined lifecycle before the change is considered complete.

### ADR Lifecycle

Every ADR moves through these statuses in order:

| Status | Meaning |
|---|---|
| **Proposed** | ADR has been created in the `adr/` directory and is open for review. |
| **Accepted** | The proposed change has been approved. |
| **Spec Updated** | `SPEC.md` has been modified to reflect the accepted change. The ADR is now complete as a decision document. |
| **Test Specified** | `TEST-SPEC.md` has been updated to account for the spec changes. |
| **Tested** | Tests have been written or updated. Some tests may intentionally fail because the implementation does not yet exist. |
| **Implemented** | The implementation is complete and all tests pass. This is the terminal status. |

### ADR Format

Each ADR is a Markdown file in the `adr/` directory, named with a zero-padded sequence number and a short slug:

```
adr/NNNN-short-description.md
```

An ADR must contain:

- **Title** — `ADR-NNNN: Short Description`
- **Status** — current lifecycle status (see above)
- **Context** — why this change is being considered
- **Decision** — what the spec change is, described precisely enough to update `SPEC.md`
- **Consequences** — what follows from this decision (trade-offs, migration, etc.)
- **Test Recommendations** *(optional)* — edge cases or scenarios that should be covered when writing tests (e.g., "be sure to verify behavior when the input list is empty"). This is not an exhaustive test plan; it highlights cases that are easy to overlook.

### Workflow

1. **Create the ADR** — Author writes the ADR in `adr/` with status **Proposed**.
2. **Review and accept** — After review, status moves to **Accepted**.
3. **Update the spec** — `SPEC.md` is modified to incorporate the decision. Status becomes **Spec Updated**.
4. **Update the test spec** — `TEST-SPEC.md` is updated to cover the new or changed spec behavior. Status becomes **Test Specified**.
5. **Write/update tests** — Tests are added or modified. Newly added tests that depend on unimplemented behavior are expected to fail. Status becomes **Tested**.
6. **Implement** — The codebase is updated to satisfy the spec and pass all tests. Status becomes **Implemented**.

### Key Principles

- An ADR specifies a change to the spec, not a code change. Implementation details belong in the code, not the ADR.
- The spec (`SPEC.md`) is the single source of truth for what the system should do. ADRs are the record of how and why the spec evolved.
- Steps 3-6 happen sequentially. Each step must be completed before moving to the next.

## Consequences

- All spec changes are traceable back to a decision record.
- The development cycle is spec-first: spec change, then test spec, then tests, then implementation.
- ADRs accumulate as a historical log of project decisions in the `adr/` directory.

## Test Recommendations

N/A — this ADR is process-only and has no implementation to test.
