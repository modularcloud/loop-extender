import { describe, it } from "vitest";

// TEST-SPEC.md §1.3 documents these as explicit known gaps: they require
// privileged host/device operations, unobservable implementation internals, or
// additional deterministic timing seams beyond the default black-box harness.
// All other formerly pending traceability IDs now have executable coverage in
// the e2e/unit/fuzz/type suites.
const pendingSpecIds = [
  "T-INST-112-block",
  "T-INST-113-package",
  "T-TMP-43",
  "T-TMP-44",
  "T-TMP-45",
  "T-VER-28-block",
] as const;

describe("SPEC: Known Traceability Gaps", () => {
  for (const id of pendingSpecIds) {
    it.todo(`${id}: documented TEST-SPEC known gap`);
  }
});
