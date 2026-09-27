import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { notifications } from "../src/db/schema/index.js";
import { EN } from "../src/i18n/catalog.js";
import { translateText, tr, withLocale } from "../src/i18n/index.js";
import { createProject, createUser, createVehicle, defaultOrgId, login, userAndClient } from "./helpers.js";

/** Every Arabic message in server/src (except the demo seed scripts) as catalog keys ({0}, {1} for template parts). */
function serverMessages(): { file: string; text: string }[] {
  const root = path.resolve("src");
  const out: { file: string; text: string }[] = [];
  const AR = /[؀-ۿ]/;
  (function walk(d: string) {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== "scripts" && f !== "i18n") walk(p);
        continue;
      }
      if (!p.endsWith(".ts")) continue;
      const sf = ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true);
      (function v(n: ts.Node) {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && AR.test(n.text)) out.push({ file: path.relative(root, p), text: n.text });
        else if (ts.isTemplateExpression(n) && (AR.test(n.head.text) || n.templateSpans.some((s) => AR.test(s.literal.text)))) {
          let text = n.head.text;
          n.templateSpans.forEach((s, i) => (text += `{${i}}${s.literal.text}`));
          out.push({ file: path.relative(root, p), text });
          n.templateSpans.forEach((s) => v(s.expression));
          return;
        }
        ts.forEachChild(n, v);
      })(sf);
    }
  })(root);
  return out;
}

describe("server message catalog", () => {
  it("has an English entry for every Arabic message in the server code", () => {
    const missing = serverMessages().filter((m) => EN[m.text] === undefined);
    expect(missing).toEqual([]);
  });

  it("keeps the same placeholders in English and no Arabic in English entries", () => {
    for (const [ar, en] of Object.entries(EN)) {
      expect([...en.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort(), ar).toEqual([...ar.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort());
      expect(/[؀-ۿ]/.test(en), `${ar} → ${en}`).toBe(false);
    }
  });

  it("tr() follows the request locale; Arabic stays the default", () => {
    expect(tr("المركبة غير موجودة")).toBe("المركبة غير موجودة");
    expect(withLocale("en", () => tr("المركبة غير موجودة"))).toBe("Vehicle not found");
    expect(withLocale("en", () => tr("الاستمارة تنتهي خلال {0} يوم", 12))).toBe("Registration expires in 12 days");
    expect(withLocale("ar", () => tr("الاستمارة تنتهي خلال {0} يوم", 12))).toBe("الاستمارة تنتهي خلال 12 يوم");
  });
});

describe("stored system text (notifications) is translated on read", () => {
  const en = (s: string) => translateText(s, "en");
  it("fills templates, including nested fragments and plates with spaces", () => {
    expect(en("تم إغلاق الفاتورة INV-7 كمدفوعة")).toBe("Invoice INV-7 closed as paid");
    expect(en("طلب صيانة جديد MR-12 للمركبة DEMO-3101")).toBe("New maintenance request MR-12 for vehicle DEMO-3101");
    expect(en("استمارة المركبة ABC 1234 تنتهي خلال 5 يوم")).toBe("Registration of vehicle ABC 1234 expires in 5 days");
    expect(en("رخصة السائق فهد القحطاني منتهية منذ 3 يوم")).toBe("Driver license of فهد القحطاني expired 3 days ago");
    expect(en("رخصة القيادة الخاصة بك تنتهي اليوم")).toBe("Your driving license expires today");
    // optional fragment appended to a template ({0}{1})
    expect(en("تمت إعادة المركبة DEMO-3201 — 2 ملاحظة ضرر جديدة")).toBe("Vehicle DEMO-3201 returned — 2 new damage notes");
    expect(en("تمت إعادة المركبة DEMO-3201")).toBe("Vehicle DEMO-3201 returned");
    expect(en("تم رفض الفاتورة INV-9: المبلغ غير مطابق")).toBe("Invoice INV-9 rejected: المبلغ غير مطابق"); // the user's reason is not translated
  });
  it("never translates arbitrary user text and leaves Arabic untouched in Arabic", () => {
    expect(en("صيانة النظام الليلة")).toBe("صيانة النظام الليلة");
    expect(en("أبيض")).toBe("أبيض");
    expect(translateText("تم إغلاق الفاتورة INV-7 كمدفوعة", "ar")).toBe("تم إغلاق الفاتورة INV-7 كمدفوعة");
  });
});

describe("HTTP responses follow X-Locale / ?lang", () => {
  it("errors (HttpError and validation details) in English, Arabic by default", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await client.get(`/api/vehicles/${id}`)).body.error.message).toBe("المركبة غير موجودة");
    expect((await client.get(`/api/vehicles/${id}`).set("X-Locale", "en")).body.error.message).toBe("Vehicle not found");
    expect((await client.get(`/api/vehicles/${id}?lang=en`)).body.error.message).toBe("Vehicle not found");
    const bad = await client.post("/api/vehicles", { plateNumber: "" }).set("X-Locale", "en");
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe("The data entered is invalid");
    expect(JSON.stringify(bad.body)).not.toMatch(/[؀-ۿ]/);
    const login = await (await import("supertest")).default((await import("./helpers.js")).app).post("/api/auth/login").set("X-Locale", "en").send({ email: "nobody@example.test", password: "Wrong-Passw0rd!" });
    expect(login.body.error.message).toBe("Incorrect email or password");
  });

  it("never shows zod's technical messages: friendly field errors in both languages", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const body = { plateNumber: null, make: "x".repeat(200), model: "M", year: 1.5, unknownField: 1 };
    const ar = (await client.post("/api/vehicles", body)).body.error;
    const en = (await client.post("/api/vehicles", body).set("X-Locale", "en")).body.error;
    const msgs = (e: { details: { path: string; message: string }[] }) => Object.fromEntries(e.details.map((d) => [d.path, d.message]));
    for (const e of [ar, en]) expect(JSON.stringify(e)).not.toMatch(/Invalid input|expected string|Too big|Unrecognized key/);
    expect(msgs(ar).plateNumber).toBe("هذا الحقل مطلوب");
    expect(msgs(en).plateNumber).toBe("This field is required");
    expect(Object.values(msgs(en)).every((m) => !/[؀-ۿ]/.test(m))).toBe(true);
  });

  it("system notifications are shown in the reader's language; broadcasts and stored rows are untouched", async () => {
    const u = await createUser(["SUPER_ADMIN"]);
    const orgId = await defaultOrgId();
    await db.insert(notifications).values([
      { organizationId: orgId, userId: u.id, type: "INVOICE_PAID", category: "FINANCE", title: "تم إغلاق الفاتورة INV-3 كمدفوعة" },
      { organizationId: orgId, userId: u.id, type: "SYSTEM_BROADCAST", category: "SYSTEM", title: "تم إغلاق الفاتورة INV-3 كمدفوعة" },
    ]);
    const c = await login(u.email);
    const enRows = (await c.get("/api/notifications").set("X-Locale", "en")).body.data as { type: string; title: string }[];
    expect(enRows.find((r) => r.type === "INVOICE_PAID")!.title).toBe("Invoice INV-3 closed as paid");
    expect(enRows.find((r) => r.type === "SYSTEM_BROADCAST")!.title).toBe("تم إغلاق الفاتورة INV-3 كمدفوعة");
    const arRows = (await c.get("/api/notifications")).body.data as { type: string; title: string }[];
    expect(arRows.find((r) => r.type === "INVOICE_PAID")!.title).toBe("تم إغلاق الفاتورة INV-3 كمدفوعة");
    const stored = await db.select({ title: notifications.title }).from(notifications).where(eq(notifications.userId, u.id));
    expect(stored.every((s) => s.title.startsWith("تم إغلاق"))).toBe(true);
  });

  it("reports (definitions, JSON meta and CSV headers) follow the language; CSV keeps the BOM", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    const defs = (await client.get("/api/reports").set("X-Locale", "en")).body.data as { key: string; title: string; columns: { label: string }[] }[];
    expect(defs.find((d) => d.key === "fuel")!.title).toBe("Fuel report");
    expect(defs.find((d) => d.key === "fuel")!.columns.map((c) => c.label)).toContain("Liters");
    expect((await client.get("/api/reports")).body.data.find((d: { key: string }) => d.key === "fuel").title).toBe("تقرير الوقود");
    const csvEn = await client.get("/api/reports/fuel?format=csv&lang=en");
    expect(csvEn.status).toBe(200);
    expect(csvEn.text.charCodeAt(0)).toBe(0xfeff);
    expect(csvEn.text.split("\r\n")[0]).toContain("Liters");
    const csvAr = await client.get("/api/reports/fuel?format=csv");
    expect(csvAr.text.split("\r\n")[0]).toContain("اللترات");
  });

  it("dashboard alerts, role names and vehicle timeline are localized", async () => {
    const { user, client } = await userAndClient(["SUPER_ADMIN"]);
    const roles = (await client.get("/api/roles").set("X-Locale", "en")).body.data as { key: string; nameAr: string }[];
    expect(roles.find((r) => r.key === "SUPER_ADMIN")!.nameAr).toBe("System administrator");
    const perms = (await client.get("/api/roles/permissions").set("X-Locale", "en")).body.data as { key: string; descriptionAr: string }[];
    expect(perms.find((p) => p.key === "vehicles.read")!.descriptionAr).toBe("View vehicles");
    const p = await createProject({ managerId: user.id });
    const v = await createVehicle(p.id);
    await client.patch(`/api/vehicles/${v.id}`, { color: "أزرق" });
    const tl = (await client.get(`/api/vehicles/${v.id}/timeline`).set("X-Locale", "en")).body.data as { description: string }[];
    expect(tl.length).toBeGreaterThan(0);
    expect(tl.some((e) => /Vehicle details updated|Vehicle added/.test(e.description))).toBe(true);
    const dash = (await client.get("/api/dashboard").set("X-Locale", "en")).body.data;
    for (const a of dash.alerts as { title: string }[]) expect(a.title).not.toMatch(/[؀-ۿ]/);
  });
});
