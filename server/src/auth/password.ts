import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { config } from "../config.js";

/**
 * Password hashing with scrypt (memory-hard, built into Node — no native deps).
 * Format: scrypt$<logN>$<r>$<p>$<saltB64>$<hashB64>
 * Parameters are stored with each hash so they can be raised later; verify()
 * reports when a hash should be upgraded.
 */
const KEYLEN = 64;
const R = 8;
const P = 1;

function scrypt(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  const opts: ScryptOptions = { N, r, p, maxmem: 128 * N * r * 2 };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const logN = config.SCRYPT_LOG_N;
  const key = await scrypt(password, salt, logN, R, P);
  return `scrypt$${logN}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return { ok: false, needsRehash: false };
  const [, logNs, rs, ps, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const logN = Number(logNs);
  const r = Number(rs);
  const p = Number(ps);
  if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 20) return { ok: false, needsRehash: false };
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), logN, r, p);
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  return { ok, needsRehash: ok && (logN < config.SCRYPT_LOG_N || r !== R || p !== P) };
}

/** Pre-computed hash used to equalize timing when the email does not exist. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

/** Password policy shared by create/reset/change endpoints. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export function passwordPolicyError(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN} أحرف`;
  if (pw.length > PASSWORD_MAX) return `كلمة المرور يجب ألا تزيد عن ${PASSWORD_MAX} حرفًا`;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) return "كلمة المرور يجب أن تحتوي على 3 أنواع على الأقل من: حروف صغيرة، كبيرة، أرقام، رموز";
  return null;
}

export function generateTemporaryPassword(): string {
  // 18 chars from a URL-safe alphabet + guaranteed classes.
  return `${randomBytes(12).toString("base64url")}aA1!`;
}
