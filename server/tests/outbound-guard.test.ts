import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { emailSettings } from "../src/db/schema/index.js";
import { isForbiddenOutboundHost } from "../src/lib/net-guard.js";
import { defaultOrgId, userAndClient } from "./helpers.js";

describe("hosts an administrator-editable setting may never point the server at", () => {
  it("blocks loopback, link-local (cloud metadata), localhost and odd IP spellings; allows names and private ranges", () => {
    for (const h of ["localhost", "LOCALHOST", "foo.localhost", "127.0.0.1", "127.1.2.3", "169.254.169.254", "169.254.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1", "[::1]", "2130706433", "0x7f000001", "0x7f.0.0.1", "017700000001", "", "localhost."]) {
      expect(isForbiddenOutboundHost(h), h).toBe(true);
    }
    for (const h of ["smtp.example.com", "email-smtp.eu-central-1.amazonaws.com", "mail.company.sa", "10.0.1.25", "172.16.5.4", "192.168.1.10", "cafe.de", "dead.beef.com", "8.8.8.8"]) {
      expect(isForbiddenOutboundHost(h), h).toBe(false);
    }
  });
});

describe("Settings → Email SMTP host", () => {
  let before: string | null | undefined;
  afterAll(async () => {
    const orgId = await defaultOrgId();
    await db.update(emailSettings).set({ smtpHost: before ?? null }).where(eq(emailSettings.organizationId, orgId));
  });

  it("rejects a metadata / loopback host with 400 and accepts a normal one", async () => {
    const orgId = await defaultOrgId();
    before = (await db.select().from(emailSettings).where(eq(emailSettings.organizationId, orgId)))[0]?.smtpHost;
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    for (const h of ["169.254.169.254", "127.0.0.1", "localhost", "2130706433", "0x7f000001"]) {
      const r = await client.put("/api/settings/email", { smtpHost: h });
      expect(r.status, h).toBe(400);
    }
    expect((await client.put("/api/settings/email", { smtpHost: "email-smtp.eu-central-1.amazonaws.com" })).status).toBe(200);
    expect((await client.put("/api/settings/email", { smtpHost: "10.0.1.25" })).status).toBe(200); // a relay inside the VPC stays possible
  });
});
