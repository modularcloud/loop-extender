import { describe, it, expectTypeOf } from "vitest";
import type { Output, RunOptions } from "loopx";
import type { run, runPromise } from "loopx";

/**
 * TEST-SPEC §6.4 — Compile-time type surface verification.
 *
 * These tests use vitest typecheck mode (expectTypeOf) to verify the public
 * TypeScript type surface documented in Spec 9.5.
 *
 * Run via: vitest typecheck tests/unit/types.test.ts
 * or: tsc --noEmit
 *
 * These are type-level assertions — they verify that the types are correctly
 * shaped at compile time, not at runtime.
 *
 * IMPORTANT: Each test includes a `not.toBeAny()` guard to ensure the test
 * fails when the "loopx" module is not installed (which would cause the
 * imported types to resolve to `any`, silently satisfying all assertions).
 */

describe("SPEC: Type Surface Verification", () => {
  // T-TYPE-01: import type { Output, RunOptions } from "loopx" compiles
  it("T-TYPE-01: Output and RunOptions types are importable from 'loopx'", () => {
    // Guard: ensure types are not `any` (would be if module is missing)
    expectTypeOf<Output>().not.toBeAny();
    expectTypeOf<RunOptions>().not.toBeAny();

    // The fact that this file compiles with the imports above verifies T-TYPE-01.
    expectTypeOf<Output>().not.toBeNever();
    expectTypeOf<RunOptions>().not.toBeNever();
  });

  // T-TYPE-02: Output has optional result?: string, goto?: string, stop?: boolean
  it("T-TYPE-02: Output has correct optional fields", () => {
    expectTypeOf<Output>().not.toBeAny();

    // Verify each field exists and is the correct type
    expectTypeOf<Output>().toHaveProperty("result");
    expectTypeOf<Output>().toHaveProperty("goto");
    expectTypeOf<Output>().toHaveProperty("stop");

    // Verify field types
    expectTypeOf<Output["result"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Output["goto"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Output["stop"]>().toEqualTypeOf<boolean | undefined>();

    // Verify all fields are optional: an empty object should be assignable to Output
    expectTypeOf<{}>().toMatchTypeOf<Output>();
  });

  // T-TYPE-03: RunOptions has optional fields
  it("T-TYPE-03: RunOptions has correct optional fields", () => {
    expectTypeOf<RunOptions>().not.toBeAny();

    expectTypeOf<RunOptions>().toHaveProperty("maxIterations");
    expectTypeOf<RunOptions>().toHaveProperty("cwd");
    expectTypeOf<RunOptions>().toHaveProperty("envFile");
    expectTypeOf<RunOptions>().toHaveProperty("signal");

    // Verify field types
    expectTypeOf<RunOptions["maxIterations"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<RunOptions["cwd"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RunOptions["envFile"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<RunOptions["signal"]>().toEqualTypeOf<
      AbortSignal | undefined
    >();

    // Verify all fields are optional: an empty object should be assignable
    expectTypeOf<{}>().toMatchTypeOf<RunOptions>();
  });

  // T-TYPE-04: run() returns AsyncGenerator<Output>
  it("T-TYPE-04: run() returns AsyncGenerator<Output>", () => {
    type RunReturn = ReturnType<typeof run>;
    expectTypeOf<RunReturn>().not.toBeAny();
    expectTypeOf<RunReturn>().toMatchTypeOf<AsyncGenerator<Output>>();
  });

  // T-TYPE-05: runPromise() returns Promise<Output[]>
  it("T-TYPE-05: runPromise() returns Promise<Output[]>", () => {
    type RunPromiseReturn = ReturnType<typeof runPromise>;
    expectTypeOf<RunPromiseReturn>().not.toBeAny();
    expectTypeOf<RunPromiseReturn>().toMatchTypeOf<Promise<Output[]>>();
  });

  // T-TYPE-06: Both accept optional RunOptions
  it("T-TYPE-06: run() and runPromise() accept optional RunOptions as second argument", () => {
    // Verify that calling with (string, RunOptions) is valid
    type RunParams = Parameters<typeof run>;
    type RunPromiseParams = Parameters<typeof runPromise>;

    expectTypeOf<RunParams>().not.toBeAny();
    expectTypeOf<RunPromiseParams>().not.toBeAny();

    // Second parameter should accept RunOptions
    expectTypeOf<RunOptions>().toMatchTypeOf<NonNullable<RunParams[1]>>();
    expectTypeOf<RunOptions>().toMatchTypeOf<
      NonNullable<RunPromiseParams[1]>
    >();

    // Second parameter should be optional (the function accepts 0, 1, or 2 args)
    // Verify by checking that the parameter tuple length allows omission
    expectTypeOf<[]>().toMatchTypeOf<RunParams>();
    expectTypeOf<[]>().toMatchTypeOf<RunPromiseParams>();
  });

  // T-TYPE-07: Both accept optional script name as first argument
  it("T-TYPE-07: run() and runPromise() accept optional script name (string | undefined)", () => {
    type RunParams = Parameters<typeof run>;
    type RunPromiseParams = Parameters<typeof runPromise>;

    expectTypeOf<RunParams>().not.toBeAny();
    expectTypeOf<RunPromiseParams>().not.toBeAny();

    // First parameter should accept string
    expectTypeOf<string>().toMatchTypeOf<NonNullable<RunParams[0]>>();
    expectTypeOf<string>().toMatchTypeOf<
      NonNullable<RunPromiseParams[0]>
    >();

    // First parameter should be optional
    expectTypeOf<[string]>().toMatchTypeOf<RunParams>();
    expectTypeOf<[string]>().toMatchTypeOf<RunPromiseParams>();

    // Should also accept undefined
    expectTypeOf<[undefined]>().toMatchTypeOf<RunParams>();
    expectTypeOf<[undefined]>().toMatchTypeOf<RunPromiseParams>();
  });
});
