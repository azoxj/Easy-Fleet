import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMailbox, parseSmtpSecure } from "../src/config.js";

describe("email settings from the environment are parsed leniently", () => {
  it("SMTP_SECURE accepts TLS/STARTTLS/NONE and the nodemailer true/false style", () => {
    for (const v of ["TLS", "tls", "ssl", "true", "1", "TRUE"]) expect(parseSmtpSecure(v), v).toBe("TLS");
    for (const v of ["STARTTLS", "starttls", "false", "0", "False"]) expect(parseSmtpSecure(v), v).toBe("STARTTLS");
    expect(parseSmtpSecure("none")).toBe("NONE");
    expect(parseSmtpSecure("maybe")).toBeUndefined();
  });

  it('EMAIL_FROM accepts "address" and "Name <address>"', () => {
    expect(parseMailbox("no-reply@fleet.example")).toEqual({ address: "no-reply@fleet.example", name: null });
    expect(parseMailbox("Easy Fleet <no-reply@fleet.example>")).toEqual({ address: "no-reply@fleet.example", name: "Easy Fleet" });
    expect(parseMailbox('"إيزي فليت" <no-reply@fleet.example>')).toEqual({ address: "no-reply@fleet.example", name: "إيزي فليت" });
    expect(parseMailbox("not an address")).toBeNull();
    expect(parseMailbox("")).toBeNull();
  });

  it("odd or invalid email variables never stop the server from starting, and values are never printed", () => {
    const tsx = path.resolve("../node_modules/.bin/tsx");
    const secret = "Brevo-Smtp-Key-xyz123";
    const env = {
      PATH: process.env.PATH!,
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL!,
      SMTP_HOST: "smtp-relay.brevo.com",
      SMTP_PORT: "not-a-port",
      SMTP_USER: "login@example.test",
      SMTP_PASSWORD: secret,
      SMTP_SECURE: "false",
      EMAIL_FROM: "Easy Fleet <no-reply@fleet.example>",
      SUPPORT_EMAIL: "nope",
      EMAIL_SETTINGS_KEY: "too-short",
      APP_URL: "fleet.example", // not a URL
      PASSWORD_RESET_TTL_MINUTES: "abc",
    };
    const script = `import("./src/config.ts").then(({ config: c }) => console.log(JSON.stringify({ port: c.SMTP_PORT ?? null, secure: c.SMTP_SECURE, from: c.EMAIL_FROM, fromName: c.EMAIL_FROM_NAME, support: c.SUPPORT_EMAIL ?? null, key: c.EMAIL_SETTINGS_KEY ?? null, ttl: c.PASSWORD_RESET_TTL_MINUTES, appUrl: c.APP_URL ?? null })))`;
    const out = execFileSync(tsx, ["-e", script], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const last = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(last).toEqual({ port: null, secure: "STARTTLS", from: "no-reply@fleet.example", fromName: "Easy Fleet", support: null, key: null, ttl: 30, appUrl: null });
    expect(out).not.toContain(secret);
  });

  it("the startup warnings name the setting but never its value", () => {
    const tsx = path.resolve("../node_modules/.bin/tsx");
    const env = { PATH: process.env.PATH!, NODE_ENV: "test", DATABASE_URL: process.env.DATABASE_URL!, SMTP_SECURE: "sometimes", EMAIL_FROM: "secret-looking-value", SMTP_PASSWORD: "Brevo-Smtp-Key-xyz123" };
    const res = execFileSync(tsx, ["-e", `import("./src/config.ts").then(() => console.error("done"))`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    void res;
    let stderr = "";
    try {
      execFileSync(tsx, ["-e", `import("./src/config.ts").then(() => { throw new Error("x") })`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      stderr = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(stderr).toContain("SMTP_SECURE must be TLS, STARTTLS, NONE, true or false; ignoring it");
    expect(stderr).toContain("EMAIL_FROM is not a valid email address; ignoring it");
    expect(stderr).not.toContain("secret-looking-value");
    expect(stderr).not.toContain("Brevo-Smtp-Key-xyz123");
  });
});
