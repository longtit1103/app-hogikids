import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/password";

const scrypt = promisify(scryptCallback);

describe("hashPassword / verifyPassword", () => {
  it("verifies a freshly hashed password", async () => {
    const hash = await hashPassword("Mat-khau-manh-123");
    await expect(verifyPassword("Mat-khau-manh-123", hash)).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("Mat-khau-manh-123");
    await expect(verifyPassword("mat-khau-sai", hash)).resolves.toBe(false);
  });

  it("stores '<saltHex>:<derivedKeyHex>' with a 16-byte salt and 64-byte key", async () => {
    const hash = await hashPassword("Mat-khau-manh-123");
    const [salt, derivedKeyHex] = hash.split(":");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(derivedKeyHex).toMatch(/^[0-9a-f]{128}$/);
  });

  it("does not throw on a malformed stored hash — just fails verification", async () => {
    await expect(verifyPassword("bat-ky", "not-a-valid-hash")).resolves.toBe(false);
    await expect(verifyPassword("bat-ky", "")).resolves.toBe(false);
  });

  it("verifies a hash produced the same way prisma/seed.ts produces it (salt passed as a raw hex STRING, never hex-decoded)", async () => {
    const salt = randomBytes(16).toString("hex");
    const derivedKey = (await scrypt("seed-style-password", salt, 64)) as Buffer;
    const seedStyleHash = `${salt}:${derivedKey.toString("hex")}`;

    await expect(verifyPassword("seed-style-password", seedStyleHash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", seedStyleHash)).resolves.toBe(false);
  });
});
