import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config, emailKeyBytes } from "../config.js";

/**
 * AES-256-GCM encryption for the SMTP password saved from the admin page.
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>. The key comes from
 * EMAIL_SETTINGS_KEY (never stored in the database); without it, saving a
 * password from the UI is refused and SMTP_PASSWORD (environment) is used.
 */
const key = () => (config.EMAIL_SETTINGS_KEY ? emailKeyBytes(config.EMAIL_SETTINGS_KEY) : null);

export const canStoreSecrets = () => key() !== null;

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) throw new Error("EMAIL_SETTINGS_KEY is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

/** Returns null when the value cannot be decrypted (missing/rotated key, tampering). */
export function decryptSecret(stored: string | null | undefined): string | null {
  const k = key();
  if (!stored || !k) return null;
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "v1" || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
