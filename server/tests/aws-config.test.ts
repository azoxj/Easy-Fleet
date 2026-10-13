import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyFileSecrets, FILE_SECRET_KEYS } from "../src/config.js";

const tsx = path.resolve("../node_modules/.bin/tsx");
const BASE = { PATH: process.env.PATH!, DATABASE_URL: process.env.DATABASE_URL! };
const PROD = { ...BASE, NODE_ENV: "production", COOKIE_SECURE: "true", APP_ORIGINS: "https://fleet.example.com" };

function load(env: Record<string, string>) {
  try {
    const r = execFileSync(tsx, ["tests/fixtures/print-aws-config.ts"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true as const, cfg: JSON.parse(r.split("\n").find((l) => l.startsWith("CFG "))!.slice(4)), out: r };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    return { ok: false as const, error: `${err.stderr ?? ""}${err.stdout ?? ""}${err.message}` };
  }
}
const tmp = () => mkdtempSync(path.join(tmpdir(), "ef-secret-"));

describe("TRUST_PROXY behind the AWS reverse proxy", () => {
  it("defaults to one proxy in production and none elsewhere; an explicit value always wins", () => {
    expect(load({ ...PROD }).ok && (load({ ...PROD }) as { cfg: { trustProxy: number } }).cfg.trustProxy).toBe(1);
    expect((load({ ...BASE, NODE_ENV: "development" }) as { cfg: { trustProxy: number } }).cfg.trustProxy).toBe(0);
    expect((load({ ...PROD, TRUST_PROXY: "2" }) as { cfg: { trustProxy: number } }).cfg.trustProxy).toBe(2);
    expect((load({ ...BASE, NODE_ENV: "development", TRUST_PROXY: "1" }) as { cfg: { trustProxy: number } }).cfg.trustProxy).toBe(1);
  });

  it("warns (without failing) when production is explicitly set to 0", () => {
    const r = spawnSync(tsx, ["tests/fixtures/print-aws-config.ts"], { env: { ...PROD, TRUST_PROXY: "0" }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("TRUST_PROXY=0 in production");
    const ok = spawnSync(tsx, ["tests/fixtures/print-aws-config.ts"], { env: { ...PROD }, encoding: "utf8" });
    expect(ok.stderr).not.toContain("TRUST_PROXY");
  });

  it("production defaults: JSON logs and request logging on; development: text, off", () => {
    const p = load({ ...PROD }) as { cfg: { logFormat: string; logRequests: boolean } };
    expect(p.cfg).toMatchObject({ logFormat: "json", logRequests: true });
    const d = load({ ...BASE, NODE_ENV: "development" }) as { cfg: { logFormat: string; logRequests: boolean } };
    expect(d.cfg).toMatchObject({ logFormat: "text", logRequests: false });
  });
});

describe("secrets from files (AWS Secrets Manager → /run/…)", () => {
  it("NAME_FILE fills NAME; a value set directly wins; a trailing newline is trimmed", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "pw"), "from-file\n");
    expect(applyFileSecrets({ SMTP_PASSWORD_FILE: path.join(dir, "pw") }).SMTP_PASSWORD).toBe("from-file");
    expect(applyFileSecrets({ SMTP_PASSWORD: "direct", SMTP_PASSWORD_FILE: path.join(dir, "pw") }).SMTP_PASSWORD).toBe("direct");
    expect(applyFileSecrets({ SMTP_PASSWORD: "  ", SMTP_PASSWORD_FILE: path.join(dir, "pw") }).SMTP_PASSWORD).toBe("from-file");
    expect(applyFileSecrets({}).SMTP_PASSWORD).toBeUndefined();
  });

  it("an unreadable file fails with a message that names the variable and never any content", () => {
    expect(() => applyFileSecrets({ DATABASE_URL_FILE: "/nonexistent/secret" })).toThrow("DATABASE_URL_FILE is set but the file cannot be read");
  });

  it("only the known secret names are read from files", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "x"), "nope");
    expect(applyFileSecrets({ NODE_ENV_FILE: path.join(dir, "x") }).NODE_ENV).toBeUndefined();
    expect([...FILE_SECRET_KEYS]).toEqual(expect.arrayContaining(["DATABASE_URL", "EMAIL_SETTINGS_KEY", "SMTP_PASSWORD", "BRIGHT_WASHING_API_SECRET", "BRIGHT_WASHING_INTEGRATION_ID"]));
  });

  it("the application starts with every secret supplied as a file, and prints no secret value", () => {
    const dir = tmp();
    const put = (n: string, v: string) => (writeFileSync(path.join(dir, n), `${v}\n`), path.join(dir, n));
    const dbUrl = process.env.DATABASE_URL!;
    const r = load({
      PATH: process.env.PATH!,
      NODE_ENV: "production",
      COOKIE_SECURE: "true",
      APP_ORIGINS: "https://fleet.example.com",
      DATABASE_URL_FILE: put("DATABASE_URL", dbUrl),
      SMTP_PASSWORD_FILE: put("SMTP_PASSWORD", "smtp-secret-value-123"),
      EMAIL_SETTINGS_KEY_FILE: put("EMAIL_SETTINGS_KEY", Buffer.alloc(32, 3).toString("base64")),
      BRIGHT_WASHING_API_SECRET_FILE: put("BRIGHT_WASHING_API_SECRET", "bw-secret-value-456"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cfg).toMatchObject({ hasDatabaseUrl: true, hasSmtpPassword: true, hasKey: true, hasBwSecret: true, dbUrlLength: dbUrl.length });
    expect(r.out).not.toContain("smtp-secret-value-123");
    expect(r.out).not.toContain("bw-secret-value-456");
  });
});

describe("storage and database settings", () => {
  it("S3 needs a bucket and a region; valid settings load", () => {
    expect((load({ ...PROD, STORAGE_PROVIDER: "s3" }) as { ok: boolean }).ok).toBe(false);
    const noRegion = load({ ...PROD, STORAGE_PROVIDER: "s3", S3_BUCKET: "easy-fleet-prod-files" });
    expect(noRegion.ok).toBe(false);
    const bad = load({ ...PROD, STORAGE_PROVIDER: "s3", S3_BUCKET: "Bad_Bucket!", S3_REGION: "eu-central-1" });
    expect(bad.ok).toBe(false);
    const good = load({ ...PROD, STORAGE_PROVIDER: "s3", S3_BUCKET: "easy-fleet-prod-files", S3_REGION: "eu-central-1" });
    expect(good.ok && good.cfg).toMatchObject({ storage: "s3", bucket: "easy-fleet-prod-files" });
  });

  it("local storage stays the default (Render and development unchanged)", () => {
    const r = load({ ...PROD }) as { cfg: { storage: string } };
    expect(r.cfg.storage).toBe("local");
  });

  it("database defaults are bounded and overridable", () => {
    const d = load({ ...BASE, NODE_ENV: "development" }) as { cfg: { pool: number[] } };
    expect(d.cfg.pool).toEqual([10, 5000, 30000, 60000]);
    const o = load({ ...BASE, NODE_ENV: "development", DB_POOL_MAX: "20", DB_CONNECTION_TIMEOUT_MS: "2000", DB_STATEMENT_TIMEOUT_MS: "0", DB_IDLE_IN_TX_TIMEOUT_MS: "5000" }) as { cfg: { pool: number[] } };
    expect(o.cfg.pool).toEqual([20, 2000, 0, 5000]);
    expect(load({ ...BASE, NODE_ENV: "development", DB_POOL_MAX: "0" }).ok).toBe(false);
  });
});
