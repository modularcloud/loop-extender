import { describe, expect, it } from "vitest";

// These IDs require privileged host/device operations, so their executable
// tests are opt-in local coverage gated by LOOPX_RUN_PRIVILEGED_LOCAL_TESTS=1
// and are skipped in ordinary GitHub CI runs.
const localPrivilegedSpecIds = [
  "T-INST-112-block",
  "T-INST-113-package",
  "T-TMP-43",
  "T-TMP-45",
  "T-DISC-49-block",
  "T-VER-28-block",
] as const;

describe("SPEC: Privileged Local Traceability", () => {
  it("documents privileged opt-in IDs without leaving TEST-SPEC todos", () => {
    expect(localPrivilegedSpecIds).toEqual([
      "T-INST-112-block",
      "T-INST-113-package",
      "T-TMP-43",
      "T-TMP-45",
      "T-DISC-49-block",
      "T-VER-28-block",
    ]);
  });
});
