import { randomBytes, scrypt } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { canonicalPassword, hashPassword, passwordPolicyError, verifyPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { users } from "../src/db/schema/index.js";
import { app, createUser } from "./helpers.js";

const login = (email: string, password: string) => request(app).post("/api/auth/login").set("origin", "http://localhost:5173").send({ email, password });

describe("password typed on an Arabic keyboard", () => {
  it("canonical form: Arabic-Indic / Persian digits → 0-9, direction marks removed, letters untouched", () => {
    expect(canonicalPassword("Fleet-٢٠٢٦!")).toBe("Fleet-2026!");
    expect(canonicalPassword("Fleet-۲۰۲۶!")).toBe("Fleet-2026!");
    expect(canonicalPassword("‏Fleet-2026!‎")).toBe("Fleet-2026!");
    expect(canonicalPassword("كلمةسر-Ab1")).toBe("كلمةسر-Ab1");
    expect(passwordPolicyError("Fleetpass-٢٠٢٦")).toBeNull(); // Arabic digits count as digits
  });

  it("logs in whether the digits are typed as 123 or ١٢٣", async () => {
    const u = await createUser(["VIEWER"]);
    await db.update(users).set({ passwordHash: await hashPassword("Easy-Fleet-2026") }).where(eq(users.id, u.id));
    expect((await login(u.email, "Easy-Fleet-2026")).status).toBe(200);
    expect((await login(u.email, "Easy-Fleet-٢٠٢٦")).status).toBe(200);
    expect((await login(u.email, "Easy-Fleet-۲۰۲۶")).status).toBe(200);
    expect((await login(u.email, "Easy-Fleet-2027")).status).toBe(401);
  });

  it("still accepts hashes saved before the change (raw Arabic digits) and upgrades them", async () => {
    // a legacy hash: scrypt over the NFKC password with its Arabic digits kept as typed
    const salt = randomBytes(16);
    const key: Buffer = await new Promise((res, rej) => scrypt("Legacy-٢٠٢٦x".normalize("NFKC"), salt, 64, { N: 2 ** 10, r: 8, p: 1, maxmem: 128 * 2 ** 10 * 8 * 2 }, (e, k) => (e ? rej(e) : res(k))));
    const legacy = `scrypt$10$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(await verifyPassword("Legacy-٢٠٢٦x", legacy)).toEqual({ ok: true, needsRehash: true });
    expect((await verifyPassword("Legacy-2026y", legacy)).ok).toBe(false);
  });
});
