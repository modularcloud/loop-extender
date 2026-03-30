import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    projects: [
      {
        test: {
          name: "harness",
          include: ["tests/harness/**/*.test.ts"],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "signals",
          include: ["tests/e2e/signals.test.ts"],
          testTimeout: 60_000,
          sequence: { concurrent: false },
        },
      },
      {
        test: {
          name: "fuzz",
          include: ["tests/fuzz/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
