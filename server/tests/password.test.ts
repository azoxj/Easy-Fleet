import { describe, expect, it } from "vitest";
import { generateTemporaryPassword, hashPassword, passwordPolicyError, verifyPassword } from "../src/auth/password.js";

describe("password hashing (scrypt)", () => {
  it("produces a salted, self-describing hash that verifies", async () => {
    const h1 = await hashPassword("Correct-Horse-9");
    const h2 = await hashPassword("Correct-Horse-9");
    expect(h1).toMatch(/^scrypt\$12\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h1).not.toEqual(h2); // unique salt
    expect(h1).not.toContain("Correct-Horse-9");
    expect((await verifyPassword("Correct-Horse-9", h1)).ok).toBe(true);
  });

  it("rejects wrong passwords and malformed hashes", async () => {
    const h = await hashPassword("Correct-Horse-9");
    expect((await verifyPassword("correct-horse-9", h)).ok).toBe(false);
    expect((await verifyPassword("x", "plaintext")).ok).toBe(false);
    expect((await verifyPassword("x", "scrypt$99$8$1$aa$bb")).ok).toBe(false);
  });

  it("flags hashes made with weaker parameters for upgrade", async () => {
    const h = (await hashPassword("Correct-Horse-9")).replace(/^scrypt\$12\$/, "scrypt$11$");
    // Different params => different derived key, so re-derive properly for the check.
    const { scrypt } = await import("node:crypto");
    const [, , , , salt] = h.split("$");
    const key: Buffer = await new Promise((res, rej) =>
      scrypt("Correct-Horse-9", Buffer.from(salt!, "base64"), 64, { N: 2 ** 11, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))),
    );
    const weak = `scrypt$11$8$1$${salt}$${key.toString("base64")}`;
    expect(await verifyPassword("Correct-Horse-9", weak)).toEqual({ ok: true, needsRehash: true });
  });

  it("enforces the password policy", () => {
    expect(passwordPolicyError("short1A!")).toMatch(/10/);
    expect(passwordPolicyError("alllowercaseletters")).not.toBeNull();
    expect(passwordPolicyError("Valid-Passw0rd")).toBeNull();
    expect(passwordPolicyError("a".repeat(129))).not.toBeNull();
  });

  it("generates temporary passwords that satisfy the policy", () => {
    for (let i = 0; i < 20; i++) expect(passwordPolicyError(generateTemporaryPassword())).toBeNull();
  });
});
