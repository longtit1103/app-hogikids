import { describe, expect, it } from "vitest";

/**
 * Placeholder wiring test for Task 1 — proves the vitest setupFiles pipeline
 * (tests/setup.ts) actually runs and enforces the test-database guard before
 * any real test suite (e.g. pnl.ts, mapping) lands in later tasks.
 */
describe("vitest setup wiring", () => {
  it("overrides DATABASE_URL with TEST_DATABASE_URL before tests run", () => {
    expect(process.env.DATABASE_URL).toBeDefined();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});
