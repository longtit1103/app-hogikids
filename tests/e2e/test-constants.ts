/**
 * Single source of truth for the INGEST_SECRET used across e2e tests.
 *
 * Shared between the Playwright webServer's env override (playwright.config.ts)
 * and any e2e test that calls /api/ingest/* with a matching bearer token.
 * Deliberately a literal — never read the real INGEST_SECRET from `.env`,
 * since that is the production ingest secret.
 */
export const INGEST_SECRET_TEST = "test-ingest-secret-e2e";

/**
 * Fixed test-user credentials, seeded into `hogikids_test` by
 * tests/e2e/global-setup.ts. Deliberately literals — never derived from the
 * real INIT_EMAIL/INIT_PASSWORD, which are the production seed credentials.
 */
export const TEST_USER_EMAIL = "owner@hogikids.test";
export const TEST_USER_PASSWORD = "Test-Password-123!";

/**
 * iron-session encryption password for the e2e webServer process (must be
 * >= 32 chars — iron-session requirement). Never the real SESSION_SECRET.
 */
export const SESSION_SECRET_TEST = "e2e-test-session-secret-not-for-prod-use-only";
