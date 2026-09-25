import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** server/ directory (this file lives in server/src/http or server/dist/http). */
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Locates the built SPA (web/dist). WEB_DIST_DIR wins when set — resolved against the
 * working directory first, then against server/ (so "../web/dist" works whether the
 * process starts in the repo root or in server/). In production <repo>/web/dist next to
 * the server is always the last fallback. Only a directory containing index.html counts.
 */
export function resolveWebDist(webDistDir: string | undefined, production: boolean): { dir: string | null; tried: string[] } {
  const candidates = [
    ...(webDistDir ? [path.resolve(webDistDir), path.resolve(SERVER_DIR, webDistDir)] : []),
    ...(production ? [path.resolve(SERVER_DIR, "../web/dist")] : []),
  ];
  const tried = [...new Set(candidates)];
  const dir = tried.find((d) => existsSync(path.join(d, "index.html"))) ?? null;
  return { dir, tried };
}
