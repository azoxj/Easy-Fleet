import { isIP } from "node:net";

/** Returns the normalized https URL, or null when it is unusable as a provider endpoint. */
export function normalizeBaseUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null; // no credentials or tokens in the URL
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return null;
  if (isIP(host)) return null; // IP literals (private, loopback, link-local…) are not accepted
  if (!host.includes(".")) return null;
  return u.origin + u.pathname.replace(/\/+$/, "");
}
