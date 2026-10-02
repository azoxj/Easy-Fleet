import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { config } from "../config.js";
import { tr } from "../i18n/index.js";

/**
 * Password hashing with scrypt (memory-hard, built into Node — no native deps).
 * Format: scrypt$<logN>$<r>$<p>$<saltB64>$<hashB64>
 * Parameters are stored with each hash so they can be raised later; verify()
 * reports when a hash should be upgraded.
 */
const KEYLEN = 64;
const R = 8;
const P = 1;

/**
 * Canonical form of a password before hashing: NFKC, Arabic-Indic / Persian digits as
 * 0-9 (an iPhone with the Arabic keyboard types ١٢٣ for 123) and no invisible
 * direction marks (which RTL text fields can insert). The same password then
 * matches whichever keyboard it is typed on.
 */
export function canonicalPassword(password: string): string {
  return password
    .normalize("NFKC")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function scryptRaw(input: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  const opts: ScryptOptions = { N, r, p, maxmem: 128 * N * r * 2 };
  return new Promise((resolve, reject) => scryptCb(input, salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))));
}
const scrypt = (password: string, salt: Buffer, logN: number, r: number, p: number) => scryptRaw(canonicalPassword(password), salt, logN, r, p);

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
  const salt = Buffer.from(saltB64, "base64");
  const same = (actual: Buffer) => expected.length === actual.length && timingSafeEqual(expected, actual);
  if (same(await scrypt(password, salt, logN, r, p))) return { ok: true, needsRehash: logN < config.SCRYPT_LOG_N || r !== R || p !== P };
  // Hashes stored before canonicalization (password containing Arabic digits / marks): accept and upgrade.
  const legacy = password.normalize("NFKC");
  if (legacy !== canonicalPassword(password) && same(await scryptRaw(legacy, salt, logN, r, p))) return { ok: true, needsRehash: true };
  return { ok: false, needsRehash: false };
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
export function passwordPolicyError(raw: string): string | null {
  const pw = canonicalPassword(raw);
  if (pw.length < PASSWORD_MIN) return tr("كلمة المرور يجب ألا تقل عن {0} أحرف", PASSWORD_MIN);
  if (pw.length > PASSWORD_MAX) return tr("كلمة المرور يجب ألا تزيد عن {0} حرفًا", PASSWORD_MAX);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) return tr("كلمة المرور يجب أن تحتوي على 3 أنواع على الأقل من: حروف صغيرة، كبيرة، أرقام، رموز");
  return null;
}

export function generateTemporaryPassword(): string {
  // 18 chars from a URL-safe alphabet + guaranteed classes.
  return `${randomBytes(12).toString("base64url")}aA1!`;
}
