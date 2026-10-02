import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { emailLog, emailSettings } from "../src/db/schema/index.js";
import { sendTestEmail, setMailTransport } from "../src/email/service.js";
import { createUser, defaultOrgId } from "./helpers.js";

/**
 * The real delivery path: nodemailer → SMTP (a local SMTP server that requires
 * authentication). No mock transport here.
 */
const received: { from: string; to: string[]; raw: string }[] = [];
let server: SMTPServer;
let port = 0;
let orgId: string;

beforeAll(async () => {
  setMailTransport(null); // the real SMTP transport
  server = new SMTPServer({
    authMethods: ["PLAIN", "LOGIN"],
    disabledCommands: ["STARTTLS"], // no certificate in the test; production uses STARTTLS/TLS
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === "mailer" && auth.password === "Smtp-Pass-123") return cb(null, { user: "mailer" });
      return cb(Object.assign(new Error("Invalid credentials"), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      stream.on("end", () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.server.address() as AddressInfo).port;
  orgId = await defaultOrgId();
});

afterAll(async () => {
  await db.delete(emailSettings).where(eq(emailSettings.organizationId, orgId));
  await new Promise<void>((r) => server.close(() => r()));
});

const configure = (password: string, p = port) =>
  db
    .insert(emailSettings)
    .values({ organizationId: orgId, smtpHost: "127.0.0.1", smtpPort: p, smtpSecurity: "NONE", smtpUser: "mailer", fromEmail: "fleet@example.test", fromName: "Easy Fleet" })
    .onConflictDoUpdate({ target: emailSettings.organizationId, set: { smtpHost: "127.0.0.1", smtpPort: p, smtpSecurity: "NONE", smtpUser: "mailer" } })
    .then(async () => {
      // the password comes from the environment-equivalent config in this test
      const { config } = await import("../src/config.js");
      (config as { SMTP_PASSWORD?: string }).SMTP_PASSWORD = password;
    });

describe("SMTP delivery (nodemailer, real protocol)", () => {
  it("delivers an authenticated, UTF-8 Arabic HTML + text message", async () => {
    await configure("Smtp-Pass-123");
    const u = await createUser(["SUPER_ADMIN"]);
    const r = await sendTestEmail(orgId, u.email, "مدير الاختبار", u.id);
    expect(r).toMatchObject({ ok: true });
    expect(received).toHaveLength(1);
    const m = received[0]!;
    expect(m.from).toBe("fleet@example.test");
    expect(m.to).toEqual([u.email]);
    expect(m.raw).toMatch(/^Subject: =\?UTF-8\?/m); // Arabic subject encoded
    expect(m.raw).toContain("multipart/alternative");
    expect(m.raw).toMatch(/text\/plain; charset=utf-8/i);
    expect(m.raw).toMatch(/text\/html; charset=utf-8/i);
    expect(m.raw).toContain("Auto-Submitted: auto-generated");
    expect(m.raw).not.toContain("Smtp-Pass-123");
    const [log] = await db.select().from(emailLog).where(eq(emailLog.id, r.logId!));
    expect(log).toMatchObject({ status: "SENT" });
    expect(log!.providerMessageId).toBeTruthy();
  });

  it("wrong SMTP password → FAILED with a safe reason (no credentials, no server transcript)", async () => {
    await configure("wrong-password");
    const u = await createUser(["SUPER_ADMIN"]);
    const r = await sendTestEmail(orgId, u.email, "x", u.id);
    expect(r).toMatchObject({ ok: false, reason: "SMTP authentication failed" });
    const [log] = await db.select().from(emailLog).where(eq(emailLog.id, r.logId!));
    expect(log).toMatchObject({ status: "FAILED", failureReason: "SMTP authentication failed" });
  });

  it("unreachable server → FAILED 'could not connect', the call returns instead of throwing", async () => {
    await configure("Smtp-Pass-123", 1); // nothing listens on port 1
    const u = await createUser(["SUPER_ADMIN"]);
    const r = await sendTestEmail(orgId, u.email, "x", u.id);
    expect(r).toMatchObject({ ok: false, reason: "could not connect to the SMTP server" });
  });
});
