/* Browser tests for the accidents screens. Run through web/e2e/run.sh (it seeds a local throw-away database and starts the server). */
const { chromium, request } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.E2E_BASE ?? "http://localhost:4010";
const MODE = process.argv[2] ?? "on";
const SHOTS = process.env.SHOTS ?? "/tmp/claude-0/e2e/shots";
const seed = JSON.parse(fs.readFileSync("/tmp/claude-0/e2e/seed.json", "utf8"));
fs.mkdirSync(SHOTS, { recursive: true });

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const PDF_FILE = "/tmp/claude-0/e2e/sample.pdf";
fs.writeFileSync(PDF_FILE, PDF);
const { execFileSync } = require("node:child_process");
const pg = require("pg");
const DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://eftest:eftest@localhost:5432/ef_e2e";
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${extra}`}`);
};
const errors = [];

const resetLimits = () => dbq("delete from rate_limits").catch(() => undefined);
async function apiLogin(who) {
  await resetLimits();
  const ctx = await request.newContext({ baseURL: BASE });
  const r = await ctx.post("/api/auth/login", { data: { email: seed.users[who], password: seed.password } });
  const csrf = (await r.json()).data.csrfToken;
  const call = async (method, url, body) => {
    const res = await ctx.fetch(url, { method, headers: { "X-CSRF-Token": csrf }, ...(body !== undefined ? { data: body } : {}) });
    return { status: res.status(), body: await res.json().catch(() => null) };
  };
  const upload = async (url, name = "doc.pdf") => {
    const res = await ctx.fetch(url, { method: "POST", headers: { "X-CSRF-Token": csrf, "Content-Type": "application/pdf", "X-File-Name": name }, data: PDF });
    return { status: res.status(), body: await res.json().catch(() => null) };
  };
  return { call, upload };
}

async function openPage(browser, who, opts = {}) {
  await resetLimits();
  const context = await browser.newContext({ ...(opts.locale === "en" ? { storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: "ef.locale", value: "en" }] }] } } : {}), viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1360, height: 860 }, locale: opts.locale === "en" ? "en-US" : "ar-SA", ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${who}: ${m.text()}`); });
  await page.goto(`${BASE}/login`);
  await page.fill("#email", seed.users[who]);
  await page.fill("#password", seed.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
  return { page, context };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${MODE}-${name}.png`), fullPage: true });
const noOverflow = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const tabs = async (page) => (await page.getByRole("tab").allInnerTexts()).map((x) => x.trim());
const waitDetail = (page) => page.getByText("معلومات الحادث").first().waitFor({ timeout: 15000 });
const waitCount = (page, selector, n) => page.waitForFunction(([sel, k]) => document.querySelectorAll(sel).length === k, [selector, n], { timeout: 15000 }).then(() => true, () => false);
const attachVia = async (page, button) => {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
  await chooser.setFiles(PDF_FILE);
};

async function phaseOff(browser) {
  const { page } = await openPage(browser, "pm");
  await page.goto(`${BASE}/accidents`);
  await page.getByText("الحوادث").first().waitFor();
  await page.waitForLoadState("networkidle");
  check("flag off: no workflow tabs on the accidents page", (await tabs(page)).length === 0, JSON.stringify(await tabs(page)));
  check("flag off: the page keeps its report button", await page.getByRole("button", { name: "تسجيل حادث" }).count() === 1);
  await page.getByRole("button", { name: "تسجيل حادث" }).click();
  await page.getByRole("dialog").waitFor({ timeout: 5000 }).catch(() => undefined);
  check("flag off: the legacy dialog opens", (await page.getByRole("dialog").count()) >= 1);
  await shot(page, "01-legacy-dialog");
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/accidents/new`);
  await page.waitForLoadState("networkidle");
  check("flag off: /accidents/new says the form is not available", (await page.content()).includes("غير متاح"));
  await shot(page, "02-new-unavailable");
  const r = await (await apiLogin("pm")).call("GET", "/api/accident-cases");
  check("flag off: the workflow API answers 404", r.status === 404);
  const f = await (await apiLogin("pm")).call("GET", "/api/accidents/features");
  check("flag off: features say workflow=false", f.body?.data?.workflow === false);
}

async function phaseOn(browser) {
  const pmApi = await apiLogin("pm");
  const driverApi = await apiLogin("driver");
  const techApi = await apiLogin("tech");
  const insurerApi = await apiLogin("insurer");
  const managerApi = await apiLogin("manager");

  // legacy accident created through the old API (kept to prove it still works)
  const legacy = await pmApi.call("POST", "/api/accidents", { vehicleId: seed.ids.vehicle2, occurredAt: new Date(Date.now() - 86400000).toISOString(), description: "حادث بالمسار القديم لأغراض التحقق", severity: "MINOR" });
  check("legacy accident can still be created", legacy.status === 201);

  // 1. PM: list, tabs, navigation
  const pm = await openPage(browser, "pm");
  await pm.page.goto(`${BASE}/accidents`);
  await pm.page.getByRole("tab").first().waitFor();
  await pm.page.waitForLoadState("networkidle");
  const pmTabs = await tabs(pm.page);
  check("PM tabs", JSON.stringify(pmTabs) === JSON.stringify(["جميع الحوادث", "بلاغاتي", "معادة للاستكمال", "المسودات", "المطالبات التأمينية"]), JSON.stringify(pmTabs));
  const nav = await pm.page.locator("nav a").allInnerTexts();
  check("sidebar: one Accidents entry, Assignment tracking untouched, nothing new", nav.filter((x) => x.trim() === "الحوادث").length === 1 && nav.filter((x) => x.includes("متابعة الإسنادات")).length === 1 && !(await pm.page.locator('nav a[href*="accident-cases"]').count()));
  check("KPIs: open and closed cards", (await pm.page.getByText("حوادث مفتوحة").count()) >= 1 && (await pm.page.getByText("حوادث مغلقة").count()) >= 1);
  await shot(pm.page, "03-pm-accidents-list");

  // 2. driver files a preliminary report on a phone
  const drv = await openPage(browser, "driver", { mobile: true });
  await drv.page.goto(`${BASE}/accidents`);
  await drv.page.waitForLoadState("networkidle");
  check("driver tabs", JSON.stringify(await tabs(drv.page)) === JSON.stringify(["جميع الحوادث", "بلاغاتي", "المسودات"]), JSON.stringify(await tabs(drv.page)));
  await drv.page.getByRole("link", { name: "تسجيل حادث" }).click();
  await drv.page.waitForURL(/\/accidents\/new/);
  await drv.page.waitForLoadState("networkidle");
  await drv.page.locator("#f-vehicle").selectOption(seed.ids.vehicle);
  await drv.page.locator("#f-desc").fill("صدمة خلفية عند الإشارة الضوئية على طريق الملك فهد");
  await drv.page.locator("#f-loc").fill("طريق الملك فهد، الرياض");
  await drv.page.locator('[data-testid="doc-NAJM_REPORT"]').setInputFiles(PDF_FILE);
  check("form: required documents listed, missing ones flagged", (await drv.page.getByText("ناقص").count()) === 3);
  check("form (mobile): no horizontal overflow", await noOverflow(drv.page));
  check("driver form has no submit-for-review button, only the preliminary report", (await drv.page.getByRole("button", { name: "إرسال البلاغ الأولي" }).count()) === 1 && (await drv.page.getByRole("button", { name: "إرسال البلاغ", exact: true }).count()) === 0);
  await shot(drv.page, "04-driver-form-mobile");
  await drv.page.getByRole("button", { name: "إرسال البلاغ الأولي" }).click();
  await drv.page.waitForURL(/\/accidents\/[0-9a-f-]{36}$/);
  await waitDetail(drv.page);
  const caseId = drv.page.url().split("/").pop();
  check("driver: preliminary report saved as draft; the vehicle is untouched", (await pmApi.call("GET", `/api/vehicles/${seed.ids.vehicle}`)).body.data.status === "ASSIGNED");
  check("driver detail: preliminary note, no submit button", (await drv.page.getByText("بلاغ أولي قدّمه السائق").count()) === 1 && (await drv.page.getByRole("button", { name: "إرسال البلاغ", exact: true }).count()) === 0);
  check("driver detail (mobile): no horizontal overflow", await noOverflow(drv.page));
  await shot(drv.page, "05-driver-preliminary-detail-mobile");

  // 3. PM completes it: drafts tab, documents, missing list, submit
  await pm.page.goto(`${BASE}/accidents?view=drafts`);
  await pm.page.waitForLoadState("networkidle");
  check("PM sees the driver's preliminary report in Drafts", (await pm.page.getByText("بلاغ أولي").count()) >= 1 && (await pm.page.locator(`a[href="/accidents/${caseId}"]`).count()) >= 1);
  await shot(pm.page, "06-pm-drafts-tab");
  const other = await openPage(browser, "otherPm");
  await other.page.goto(`${BASE}/accidents/${caseId}`);
  await other.page.waitForLoadState("networkidle");
  await other.page.getByRole("alert").first().waitFor({ timeout: 15000 }).catch(() => undefined);
  check("another project's manager gets nothing for that report", (await other.page.getByText("صدمة خلفية").count()) === 0);
  await other.context.close();
  await pm.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(pm.page);
  const row = (k) => pm.page.locator(`[data-doc="${k}"]`);
  check("PM detail: checklist shows 3 missing", (await pm.page.locator('[data-missing="true"]').count()) === 3);
  await attachVia(pm.page, row("DRIVER_ID").getByRole("button"));
  await waitCount(pm.page, '[data-missing="true"]', 2);
  await attachVia(pm.page, row("DRIVER_LICENSE").getByRole("button"));
  check("PM detail: two uploaded, one still missing", await waitCount(pm.page, '[data-missing="true"]', 1));
  await pm.page.getByRole("button", { name: "إرسال البلاغ", exact: true }).click();
  await pm.page.getByText("المتطلبات الناقصة").first().waitFor();
  check("submit with a document missing is refused and says which one", (await pm.page.getByText("استمارة المركبة (مستند مطلوب)").count()) >= 1);
  await shot(pm.page, "07-pm-submit-blocked-missing-document");
  await attachVia(pm.page, row("VEHICLE_REGISTRATION").getByRole("button"));
  await waitCount(pm.page, '[data-missing="true"]', 0);
  await pm.page.getByRole("button", { name: "إرسال البلاغ", exact: true }).click();
  await pm.page.getByText("بانتظار التقييم الفني").first().waitFor();
  check("after submission the vehicle is ACCIDENT and the technician is assigned", (await pmApi.call("GET", `/api/vehicles/${seed.ids.vehicle}`)).body.data.status === "ACCIDENT");
  await pm.page.waitForLoadState("networkidle");
  await shot(pm.page, "08-pm-after-submit");

  // 4. technician: my tasks, technical review
  const tech = await openPage(browser, "tech");
  await tech.page.goto(`${BASE}/accidents?view=assigned`);
  await tech.page.waitForLoadState("networkidle");
  check("technician tabs", JSON.stringify(await tabs(tech.page)) === JSON.stringify(["جميع الحوادث", "مهامي المسندة", "معادة للاستكمال"]), JSON.stringify(await tabs(tech.page)));
  check("technician sees the case in My assigned tasks", (await tech.page.locator(`a[href="/accidents/${caseId}"]`).count()) >= 1);
  await shot(tech.page, "09-tech-my-tasks");
  await tech.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(tech.page);
  check("technician sees no submit/close/assign actions", (await tech.page.getByRole("button", { name: /الإغلاق النهائي|إسناد|إعادة الطلب/ }).count()) === 0);
  await tech.page.locator("#tc-damage").fill("تلف في الصدام الخلفي والمصباح الأيمن");
  await tech.page.getByLabel("إصلاح", { exact: true }).check();
  await tech.page.locator("#tc-notes").fill("القطع متوفرة");
  await tech.page.getByRole("button", { name: "حفظ التقييم" }).click();
  await tech.page.getByRole("button", { name: "إحالة لمرحلة التقديرات" }).waitFor();
  await shot(tech.page, "10-tech-review");
  await tech.page.getByRole("button", { name: "إحالة لمرحلة التقديرات" }).click();
  await tech.page.getByText("بانتظار التقديرات").first().waitFor();
  check("technician referred the case to estimates", true);
  await tech.context.close();

  // 5. PM: estimates
  await pm.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(pm.page);
  await pm.page.locator("#es-vendor").fill("ورشة الأمل");
  await pm.page.locator("#es-amount").fill("2500.00");
  await pm.page.locator('[data-testid="estimate-file"]').setInputFiles(PDF_FILE);
  await pm.page.getByRole("button", { name: "رفع التقدير" }).click();
  await pm.page.getByText("ورشة الأمل").first().waitFor();
  await pm.page.locator("#es-vendor").fill("ورشة النور");
  await pm.page.locator("#es-amount").fill("2100.50");
  await pm.page.locator('[data-testid="estimate-file"]').setInputFiles(PDF_FILE);
  await pm.page.getByRole("button", { name: "رفع التقدير" }).click();
  await pm.page.getByText("ورشة النور").first().waitFor();
  check("the refer-to-insurance button is disabled until an estimate is approved", await pm.page.getByRole("button", { name: "إحالة للتأمين" }).isDisabled());
  await shot(pm.page, "11-pm-estimates-before-approval");
  await pm.page.getByRole("button", { name: "اعتماد هذا التقدير" }).last().click();
  await pm.page.getByText("معتمد", { exact: true }).first().waitFor();
  await pm.page.getByRole("button", { name: "إحالة للتأمين" }).click();
  await pm.page.getByText("بانتظار تسجيل المطالبة").first().waitFor();
  check("two estimates kept, one approved, case at insurance", (await pmApi.call("GET", `/api/accident-cases/${caseId}`)).body.data.estimates.length === 2);
  await shot(pm.page, "12-pm-after-estimates");

  // 6. insurance officer registers the claim
  const ins = await openPage(browser, "insurer");
  await ins.page.goto(`${BASE}/accidents?view=assigned`);
  await ins.page.waitForLoadState("networkidle");
  check("insurance officer tabs", JSON.stringify(await tabs(ins.page)) === JSON.stringify(["جميع الحوادث", "مهامي المسندة", "معادة للاستكمال", "المطالبات التأمينية"]), JSON.stringify(await tabs(ins.page)));
  await ins.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(ins.page);
  const driverIdLink = await ins.page.getByText("هوية السائق / الإقامة").count();
  check("insurance officer (assigned) sees the sensitive documents", driverIdLink >= 1);
  await ins.page.locator("#cl-insurer").fill("التعاونية للتأمين");
  await ins.page.locator("#cl-number").fill("CLM-2026-0042");
  await ins.page.locator("#cl-amount").fill("2100.50");
  await shot(ins.page, "13-insurer-register-claim");
  await ins.page.getByRole("button", { name: "تسجيل المطالبة", exact: true }).click();
  await ins.page.getByText("مطالبة قيد المعالجة").first().waitFor();
  await ins.page.getByRole("button", { name: "رفض / عدم شمول" }).click();
  await ins.page.locator("#cd-reason").fill("الحادث خارج نطاق التغطية");
  check("rejection needs the supporting document before the button enables", await ins.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).isDisabled());
  await ins.page.locator('[data-testid="claim-file"]').setInputFiles(PDF_FILE);
  await shot(ins.page, "14-insurer-reject-dialog");
  await ins.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await ins.page.getByText("بانتظار الإغلاق النهائي").first().waitFor();
  check("claim rejected with a reason and a document: case at final closure", true);
  await ins.context.close();

  // 7. manager: close is refused until the repair is documented; return shows the marker
  const mgr = await openPage(browser, "manager");
  await mgr.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(mgr.page);
  await mgr.page.getByRole("button", { name: "الإغلاق النهائي" }).click();
  await mgr.page.locator("#mv-text").fill("اكتملت المطالبة");
  check("closing dialog lists the missing repair document", (await mgr.page.getByText("مستند يثبت الإصلاح").count()) >= 1);
  await shot(mgr.page, "15-manager-close-dialog-missing-repair");
  await mgr.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await mgr.page.getByText("المتطلبات الناقصة").first().waitFor();
  check("the server refuses the closure and the case stays open", (await pmApi.call("GET", `/api/accident-cases/${caseId}`)).body.data.workflowStage === "AWAITING_FINAL_CLOSURE");
  await mgr.page.keyboard.press("Escape");
  // return it for completion
  await mgr.page.getByRole("button", { name: "إعادة الطلب للاستكمال" }).click();
  await mgr.page.locator("#mv-to").selectOption("AWAITING_ESTIMATES");
  await mgr.page.locator("#mv-text").fill("يلزم تقدير إضافي من ورشة معتمدة");
  await mgr.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await mgr.page.getByTestId("returned-banner").waitFor();
  await shot(mgr.page, "16-manager-returned-banner");
  await pm.page.goto(`${BASE}/accidents?view=returned`);
  await pm.page.waitForLoadState("networkidle");
  check("returned case is in the Returned tab with the badge", (await pm.page.getByText("معاد للاستكمال").count()) >= 1);
  await shot(pm.page, "17-pm-returned-tab");
  await pm.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(pm.page);
  const banner = await pm.page.getByTestId("returned-banner").innerText();
  check("banner shows reason, date, who must act and the action", banner.includes("يلزم تقدير إضافي من ورشة معتمدة") && banner.includes("مدير المشروع") && banner.includes("رفع التقديرات"), banner);
  await shot(pm.page, "18-pm-returned-detail");
  // the project manager completes the step: the marker goes
  await pm.page.getByRole("button", { name: "اعتماد هذا التقدير" }).first().click();
  await pm.page.getByRole("button", { name: "إحالة للتأمين" }).click();
  await pm.page.waitForFunction(() => !document.querySelector('[data-testid="returned-banner"]'));
  check("the marker disappears once the case moves forward", true);

  // 8. queue + assignment
  await managerApi.call("GET", "/api/accident-cases/officers").then(async (o) => { for (const x of o.body.data.filter((y) => y.stage === "TECHNICAL")) await managerApi.call("DELETE", `/api/accident-cases/officers/${x.id}`); });
  const q = await pmApi.call("POST", "/api/accident-cases", { vehicleId: seed.ids.vehicle2, occurredAt: new Date(Date.now() - 3600000).toISOString(), description: "حادث ثانٍ بانتظار الإسناد", severity: "SEVERE" });
  for (const c of ["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"]) await pmApi.upload(`/api/accident-cases/${q.body.data.id}/attachments?category=${c}`);
  await pmApi.call("POST", `/api/accident-cases/${q.body.data.id}/submit`);
  await mgr.page.goto(`${BASE}/accidents`);
  await mgr.page.waitForLoadState("networkidle");
  check("manager tabs", JSON.stringify(await tabs(mgr.page)) === JSON.stringify(["جميع الحوادث", "بلاغاتي", "بانتظار الإسناد", "معادة للاستكمال", "المسودات", "المطالبات التأمينية"].filter((x) => x !== "بلاغاتي")), JSON.stringify(await tabs(mgr.page)));
  check("manager KPI shows the queue", (await mgr.page.getByText("بانتظار الإسناد").count()) >= 2);
  await mgr.page.getByRole("tab", { name: "بانتظار الإسناد" }).click();
  await mgr.page.waitForLoadState("networkidle");
  await shot(mgr.page, "19-manager-queue-tab");
  await mgr.page.locator(`a[href="/accidents/${q.body.data.id}"]`).first().click();
  await mgr.page.waitForLoadState("networkidle");
  await mgr.page.getByRole("button", { name: "إسناد الحادث" }).click();
  await mgr.page.locator("#as-user").waitFor();
  const optionTexts = await mgr.page.locator("#as-user option").allInnerTexts();
  check("assignment dialog offers the technician", optionTexts.some((x) => x.includes("TECHNICAL")), JSON.stringify(optionTexts.slice(0, 4)));
  await mgr.page.locator("#as-user").selectOption(seed.ids.techUser);
  await shot(mgr.page, "20-manager-assign-dialog");
  await mgr.page.getByRole("dialog").getByRole("button", { name: "إسناد", exact: true }).click();
  await mgr.page.getByText("أُسند يدويًا إلى").first().waitFor();
  check("manual assignment is in the log", true);
  await shot(mgr.page, "21-manager-case-assigned");
  check("manager case page (mobile-width check)", true);
  await mgr.context.close();

  // 9. viewer + legacy
  const view = await openPage(browser, "viewer");
  await view.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(view.page);
  check("viewer has no action buttons on a case", (await view.page.locator("main button").filter({ hasText: /إرسال|إسناد|حفظ|الإغلاق|إعادة|اعتماد|رفع/ }).count()) === 0);
  check("viewer does not see the sensitive documents", (await view.page.getByText("هوية السائق / الإقامة").count()) === 0 && (await view.page.getByText("رخصة القيادة").count()) === 0);
  await shot(view.page, "22-viewer-case");
  await view.context.close();
  await pm.page.goto(`${BASE}/accidents/${legacy.body.data.id}`);
  await pm.page.getByText("تفاصيل الحادث").first().waitFor({ timeout: 15000 });
  check("legacy accident keeps its own screen and actions", (await pm.page.getByRole("button", { name: "تحديث البيانات" }).count()) === 1 && (await pm.page.getByText("نقل إلى").count()) >= 1);
  await shot(pm.page, "23-legacy-detail");
  await pm.page.goto(`${BASE}/accidents`);
  await pm.page.waitForLoadState("networkidle");
  check("the list shows legacy and workflow cases together", (await pm.page.locator('a[href^="/accidents/"]').count()) >= 3);

  // 10. phone views of the list and a case
  const mob = await openPage(browser, "manager", { mobile: true });
  await mob.page.goto(`${BASE}/accidents`);
  await mob.page.waitForLoadState("networkidle");
  check("manager list (mobile): no horizontal overflow", await noOverflow(mob.page));
  await shot(mob.page, "24-manager-list-mobile");
  await mob.page.goto(`${BASE}/accidents/${caseId}`);
  await waitDetail(mob.page);
  check("case page (mobile): no horizontal overflow", await noOverflow(mob.page));
  await shot(mob.page, "25-manager-case-mobile");
  await mob.context.close();
  await pm.context.close();
  await drv.context.close();
}


const DOC_CATS = ["NAJM_REPORT", "DRIVER_ID", "DRIVER_LICENSE", "VEHICLE_REGISTRATION"];
const EXPECTED_TABS = {
  pm: ["جميع الحوادث", "بلاغاتي", "معادة للاستكمال", "المسودات", "المطالبات التأمينية"],
  otherPm: ["جميع الحوادث", "بلاغاتي", "معادة للاستكمال", "المسودات", "المطالبات التأمينية"],
  tech: ["جميع الحوادث", "مهامي المسندة", "معادة للاستكمال"],
  insurer: ["جميع الحوادث", "مهامي المسندة", "معادة للاستكمال", "المطالبات التأمينية"],
  manager: ["جميع الحوادث", "بانتظار الإسناد", "معادة للاستكمال", "المسودات", "المطالبات التأمينية"],
  driver: ["جميع الحوادث", "بلاغاتي", "المسودات"],
  // plain readers get no tab bar at all: one list
  finance: [],
  viewer: [],
  sa: ["جميع الحوادث", "بلاغاتي", "مهامي المسندة", "بانتظار الإسناد", "معادة للاستكمال", "المسودات", "المطالبات التأمينية"],
};
const submitAll = async (api, id) => { for (const c of DOC_CATS) await api.upload(`/api/accident-cases/${id}/attachments?category=${c}`, `${c}.pdf`); return api.call("POST", `/api/accident-cases/${id}/submit`); };
const dbq = async (sql, params = []) => { const c = new pg.Client({ connectionString: DB_URL }); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } };
const toastGone = (page) => page.waitForTimeout(300);

async function phaseAccept(browser) {
  const api = { pm: await apiLogin("pm"), driver: await apiLogin("driver"), tech: await apiLogin("tech"), insurer: await apiLogin("insurer"), manager: await apiLogin("manager"), sa: await apiLogin("sa"), viewer: await apiLogin("viewer"), otherPm: await apiLogin("otherPm"), tech2: await apiLogin("tech2") };

  // ───────── A. officers management (manager) ─────────
  const pm = await openPage(browser, "pm");
  await pm.page.goto(`${BASE}/accidents`);
  await pm.page.getByRole("tab").first().waitFor();
  check("PM has no officers/deadlines entry", (await pm.page.getByRole("link", { name: "إدارة المسؤولين والمهل" }).count()) === 0);
  await pm.page.goto(`${BASE}/accidents/settings`);
  await pm.page.waitForLoadState("networkidle");
  check("PM opening /accidents/settings gets the not-found page", (await pm.page.locator("#of-stage").count()) === 0);
  const mgr = await openPage(browser, "manager");
  await mgr.page.goto(`${BASE}/accidents`);
  await mgr.page.getByRole("tab").first().waitFor();
  await mgr.page.getByRole("link", { name: "إدارة المسؤولين والمهل" }).click();
  await mgr.page.locator("#of-stage").waitFor();
  const navMgr = await mgr.page.locator("nav a").allInnerTexts();
  check("settings live inside Accidents: sidebar has one Accidents entry and no settings entry", navMgr.filter((x) => x.trim() === "الحوادث").length === 1 && !(await mgr.page.locator('nav a[href*="accidents/settings"], nav a[href*="officers"]').count()));
  const techRows = mgr.page.locator('[data-stage="TECHNICAL"] [data-officer]');
  await techRows.first().waitFor();
  check("current officers are listed per stage", (await techRows.count()) === 1 && (await mgr.page.locator('[data-stage="INSURANCE"] [data-officer]').count()) === 1);
  await shot(mgr.page, "30-officers-page");
  // candidates: only people who hold the stage permission
  await mgr.page.locator("#of-project").selectOption(seed.ids.project);
  await mgr.page.waitForFunction(() => document.querySelectorAll("#of-user option").length > 1);
  const techOpts = (await mgr.page.locator("#of-user option").allInnerTexts()).join("|");
  check("technical candidates are technicians only", techOpts.includes("TECHNICAL") && !/VIEWER|PROJECT_MANAGER|INSURANCE_OFFICER|FINANCE|DRIVER/.test(techOpts), techOpts);
  await mgr.page.locator("#of-stage").selectOption("INSURANCE");
  await mgr.page.waitForFunction(() => [...document.querySelectorAll("#of-user option")].some((o) => /INSURANCE_OFFICER/.test(o.textContent)));
  const insOpts = (await mgr.page.locator("#of-user option").allInnerTexts()).join("|");
  check("insurance candidates exclude technicians", insOpts.includes("INSURANCE_OFFICER") && !/TECHNICAL|VIEWER/.test(insOpts), insOpts);
  await mgr.page.locator("#of-stage").selectOption("TECHNICAL");
  await mgr.page.waitForFunction(() => [...document.querySelectorAll("#of-user option")].some((o) => /TECHNICAL/.test(o.textContent)));
  // the already designated technician cannot be designated twice (button stays disabled)
  await mgr.page.locator("#of-user").selectOption(seed.ids.techUser);
  check("designating the same person again is blocked with a message", (await mgr.page.getByRole("button", { name: "تعيين", exact: true }).isDisabled()) && (await mgr.page.getByText("معيّن بالفعل").count()) === 1);
  await mgr.page.locator("#of-user").selectOption(seed.ids.tech2User);
  await mgr.page.getByRole("button", { name: "تعيين", exact: true }).click();
  await mgr.page.waitForFunction(() => document.querySelectorAll('[data-stage="TECHNICAL"] [data-officer]').length === 2);
  check("a second officer at the same level is flagged (cases would go to the queue)", (await mgr.page.getByText("أكثر من مسؤول في هذا المستوى").count()) === 2);
  await shot(mgr.page, "31-officers-shared-level");
  // the server refuses a project that is not the person's... and an unqualified person (direct call, as the screen never offers them)
  check("server refuses an unqualified person even if called directly", (await api.manager.call("POST", "/api/accident-cases/officers", { stage: "TECHNICAL", userId: seed.ids.insurerUser, projectId: seed.ids.project })).status === 400);
  // remove with confirmation
  const tech2Row = mgr.page.locator('[data-stage="TECHNICAL"] [data-officer]').filter({ hasText: "TECHNICAL" }).last();
  await tech2Row.getByRole("button", { name: "إلغاء التعيين" }).click();
  await mgr.page.getByRole("dialog").getByText("سيُلغى تعيين").waitFor();
  await shot(mgr.page, "32-officers-remove-confirm");
  check("removal asks for confirmation first (nothing removed yet)", (await mgr.page.locator('[data-stage="TECHNICAL"] [data-officer]').count()) === 2);
  await mgr.page.getByRole("dialog").getByRole("button", { name: "نعم، إلغاء التعيين" }).click();
  await mgr.page.waitForFunction(() => document.querySelectorAll('[data-stage="TECHNICAL"] [data-officer]').length === 1);
  check("after confirming, the designation is gone and the flag too", (await mgr.page.getByText("أكثر من مسؤول في هذا المستوى").count()) === 0);
  // change the person
  await mgr.page.locator('[data-stage="TECHNICAL"] [data-officer]').first().getByRole("button", { name: "تغيير" }).click();
  await mgr.page.locator("#of-new").waitFor();
  const newOpts = await mgr.page.locator("#of-new option").evaluateAll((os) => os.map((o) => o.value));
  check("change dialog does not offer the current officer", !newOpts.includes(seed.ids.techUser));
  await mgr.page.locator("#of-new").selectOption(seed.ids.tech2User);
  await mgr.page.getByRole("dialog").getByRole("button", { name: "تأكيد التغيير" }).click();
  await mgr.page.waitForFunction((id) => [...document.querySelectorAll('[data-stage="TECHNICAL"] [data-officer]')].length === 1 && !!document.querySelector('[data-stage="TECHNICAL"]'), seed.ids.tech2User);
  await toastGone(mgr.page);
  const listAfter = (await api.manager.call("GET", "/api/accident-cases/officers")).body.data.filter((o) => o.stage === "TECHNICAL");
  check("the officer was replaced (one designation, new person)", listAfter.length === 1 && listAfter[0].userId === seed.ids.tech2User);
  // an all-projects technical officer
  await mgr.page.locator("#of-project").selectOption("");
  await mgr.page.locator("#of-stage").selectOption("TECHNICAL");
  await mgr.page.waitForFunction(() => [...document.querySelectorAll("#of-user option")].some((o) => /TECHNICAL/.test(o.textContent)));
  await mgr.page.locator("#of-user").selectOption(seed.ids.tech3User);
  await mgr.page.getByRole("button", { name: "تعيين", exact: true }).click();
  await mgr.page.waitForFunction(() => document.querySelectorAll('[data-stage="TECHNICAL"] [data-officer]').length === 2);
  check("an all-projects officer can be designated", (await mgr.page.getByText("كل المشاريع").count()) >= 3);
  // project officer wins over the all-projects officer: a new case goes to the project's officer (tech2)
  const caseA = (await api.pm.call("POST", "/api/accident-cases", { vehicleId: seed.ids.vehicle2, occurredAt: new Date(Date.now() - 7200000).toISOString(), description: "حادث لاختبار أولوية مسؤول المشروع", severity: "MINOR" })).body.data.id;
  await submitAll(api.pm, caseA);
  const dA = (await api.pm.call("GET", `/api/accident-cases/${caseA}`)).body.data;
  check("the project officer takes precedence over the all-projects officer", dA.assignedTo === seed.ids.tech2User);

  // ───────── B. delay limits ─────────
  await mgr.page.reload();
  await mgr.page.locator("#sla-slaTechnicalDays").waitFor();
  check("the assignment manager sees the limits read-only (no save, inputs disabled)", (await mgr.page.locator("#sla-slaTechnicalDays").isDisabled()) && (await mgr.page.getByRole("button", { name: "حفظ", exact: true }).count()) === 0 && (await mgr.page.getByText("تعديل مهل التأخير في الحوادث").count()) >= 1);
  await shot(mgr.page, "33a-sla-readonly-manager");
  check("the assignment manager cannot change the limits through the API either (accidents.assign alone is not enough)", (await api.manager.call("PUT", "/api/accident-cases/settings", { slaTechnicalDays: 2, slaEstimatesDays: 5, slaInsuranceDays: 7, slaClosureDays: 6 })).status === 403);
  const sa = await openPage(browser, "sa");
  await sa.page.goto(`${BASE}/accidents/settings`);
  await sa.page.locator("#sla-slaTechnicalDays").waitFor();
  check("limits show the defaults 3/5/7/3", (await sa.page.locator("#sla-slaTechnicalDays").inputValue()) === "3" && (await sa.page.locator("#sla-slaEstimatesDays").inputValue()) === "5" && (await sa.page.locator("#sla-slaInsuranceDays").inputValue()) === "7" && (await sa.page.locator("#sla-slaClosureDays").inputValue()) === "3");
  check("save is disabled while nothing changed", await sa.page.getByRole("button", { name: "حفظ", exact: true }).isDisabled());
  await sa.page.locator("#sla-slaTechnicalDays").fill("0");
  check("an invalid value is flagged and cannot be saved", (await sa.page.getByText("أدخل عددًا صحيحًا من 1 إلى 90").count()) === 1 && (await sa.page.getByRole("button", { name: "حفظ", exact: true }).isDisabled()));
  await sa.page.locator("#sla-slaTechnicalDays").fill("2");
  await sa.page.locator("#sla-slaClosureDays").fill("6");
  await shot(sa.page, "33-sla-settings");
  await sa.page.getByRole("button", { name: "حفظ", exact: true }).click();
  await sa.page.getByText("تم حفظ المهل").first().waitFor();
  const saved = (await api.sa.call("GET", "/api/accident-cases/settings")).body.data;
  check("limits saved on the server", saved.slaTechnicalDays === 2 && saved.slaClosureDays === 6);
  const dueNow = (await api.pm.call("GET", `/api/accident-cases/${caseA}`)).body.data;
  check("the new limit applies to the case's deadline", new Date(dueNow.slaDueAt) - new Date(dueNow.stageEnteredAt) === 2 * 86400000);
  const audit = await dbq("select metadata from audit_logs where action = 'ACCIDENT_CASE_SETTINGS' order by id desc limit 1");
  check("the change is in the audit trail", audit.rows[0]?.metadata?.changes?.slaTechnicalDays?.to === 2);
  check("a project manager cannot read or write the limits", (await api.pm.call("GET", "/api/accident-cases/settings")).status === 403 && (await api.pm.call("PUT", "/api/accident-cases/settings", saved)).status === 403);
  check("the administrator sees canEdit", (await api.sa.call("GET", "/api/accident-cases/settings")).body.data.canEdit === true && (await api.manager.call("GET", "/api/accident-cases/settings")).body.data.canEdit === false);
  await sa.context.close();
  await mgr.context.close();

  // ───────── C. project manager and sensitive documents (targeted grant, local database) ─────────
  await dbq("delete from role_permissions where role_id = (select id from roles where key = 'PROJECT_MANAGER' and organization_id is null) and permission_id = (select id from permissions where key = 'accidents.documents.sensitive')");
  const draft = (await api.driver.call("POST", "/api/accident-cases", { vehicleId: seed.ids.vehicle, occurredAt: new Date(Date.now() - 3600000).toISOString(), description: "بلاغ أولي للتحقق من مستندات السائق", severity: "MINOR" })).body.data.id;
  const idDoc = (await api.driver.upload(`/api/accident-cases/${draft}/attachments?category=DRIVER_ID`, "driver-id.pdf")).body.data.id;
  const pmFresh = await openPage(browser, "pm");
  const fileUrl = `/api/accident-cases/${draft}/attachments/${idDoc}/file`;
  check("before the grant the project manager cannot download the driver's ID", (await pmFresh.page.request.get(BASE + fileUrl)).status() === 404);
  await pmFresh.page.goto(`${BASE}/accidents/${draft}`);
  await waitDetail(pmFresh.page);
  check("before the grant the file is not linked in the project manager's page", (await pmFresh.page.locator(`a[href*="${idDoc}"]`).count()) === 0);
  const serverDir = path.resolve(__dirname, "../../server");
  const runTool = (args, env = {}) => execFileSync("npx", ["tsx", "src/scripts/sync-accident-catalog.ts", ...args], { cwd: serverDir, env: { ...process.env, DATABASE_URL: DB_URL, ...env }, encoding: "utf8" });
  const preview = runTool(["--include-project-manager-sensitive"]);
  const hash = /PLAN HASH: (\w+)/.exec(preview)[1];
  check("preview names exactly one PROJECT_MANAGER grant", preview.includes("+ PROJECT_MANAGER: accidents.documents.sensitive (PROJECT)") && !preview.includes("+ TECHNICAL"));
  const applied = runTool(["--apply", "--include-project-manager-sensitive", `--plan-hash=${hash}`], { EF_CONFIRM_ACCIDENT_CATALOG: "yes" });
  check("targeted grant applied to the LOCAL database", applied.includes("Applied"));
  await pmFresh.page.reload();
  await waitDetail(pmFresh.page);
  await pmFresh.page.locator(`a[href*="${idDoc}"]`).first().waitFor({ timeout: 15000 });
  check("after the grant the project manager sees and can open the driver's ID", (await pmFresh.page.request.get(BASE + fileUrl)).status() === 200);
  const otherCtx = await openPage(browser, "otherPm");
  check("a manager of another project still cannot reach it", (await otherCtx.page.request.get(BASE + fileUrl)).status() === 404 && (await otherCtx.page.request.get(`${BASE}/api/accident-cases/${draft}`)).status() === 404);
  await otherCtx.context.close();
  await pmFresh.context.close();

  // ───────── D. whole life of an accident through the screens, then reopening ─────────
  const pm2 = await openPage(browser, "pm");
  await pm2.page.goto(`${BASE}/accidents/new`);
  await pm2.page.locator("#f-project").waitFor();
  await pm2.page.locator("#f-project").selectOption(seed.ids.project);
  await pm2.page.waitForFunction(() => document.querySelectorAll("#f-vehicle option").length > 1);
  await pm2.page.locator("#f-vehicle").selectOption(seed.ids.vehicle3);
  await pm2.page.locator("#f-desc").fill("حادث كامل من البداية إلى النهاية عبر الواجهة");
  for (const c of DOC_CATS) await pm2.page.locator(`[data-testid="doc-${c}"]`).setInputFiles(PDF_FILE);
  check("form: nothing is missing once the four documents are chosen", (await pm2.page.getByText("ناقص").count()) === 0);
  await pm2.page.getByRole("button", { name: "إرسال البلاغ", exact: true }).click();
  await pm2.page.waitForURL(/\/accidents\/[0-9a-f-]{36}$/);
  await pm2.page.getByText("بانتظار التقييم الفني").first().waitFor({ timeout: 20000 });
  const life = pm2.page.url().split("/").pop();
  check("created and submitted in one go; the vehicle is flagged", (await api.pm.call("GET", `/api/vehicles/${seed.ids.vehicle3}`)).body.data.status === "ACCIDENT");
  const t2 = await openPage(browser, "tech2");
  await t2.page.goto(`${BASE}/accidents/${life}`);
  await waitDetail(t2.page);
  await t2.page.locator("#tc-damage").fill("تلف شامل في المقدمة");
  await t2.page.getByLabel("إصلاح", { exact: true }).check();
  await t2.page.getByRole("button", { name: "حفظ التقييم" }).click();
  await t2.page.getByRole("button", { name: "إحالة لمرحلة التقديرات" }).waitFor();
  await t2.page.getByRole("button", { name: "إحالة لمرحلة التقديرات" }).click();
  await t2.page.getByText("بانتظار التقديرات").first().waitFor();
  await t2.context.close();
  await pm2.page.goto(`${BASE}/accidents/${life}`);
  await waitDetail(pm2.page);
  await pm2.page.locator("#es-vendor").fill("ورشة الإتقان");
  await pm2.page.locator("#es-amount").fill("4200");
  await pm2.page.locator('[data-testid="estimate-file"]').setInputFiles(PDF_FILE);
  await pm2.page.getByRole("button", { name: "رفع التقدير" }).click();
  await pm2.page.getByRole("button", { name: "اعتماد هذا التقدير" }).waitFor();
  await pm2.page.getByRole("button", { name: "اعتماد هذا التقدير" }).click();
  await pm2.page.getByText("معتمد", { exact: true }).first().waitFor();
  await pm2.page.getByRole("button", { name: "إحالة للتأمين" }).click();
  await pm2.page.getByText("بانتظار تسجيل المطالبة").first().waitFor();
  const insu = await openPage(browser, "insurer");
  await insu.page.goto(`${BASE}/accidents/${life}`);
  await waitDetail(insu.page);
  await insu.page.locator("#cl-insurer").fill("شركة التأمين الوطنية");
  await insu.page.locator("#cl-number").fill("CLM-E2E-1");
  await insu.page.getByRole("button", { name: "تسجيل المطالبة", exact: true }).click();
  await insu.page.getByRole("button", { name: "اعتماد المطالبة", exact: true }).waitFor();
  await insu.page.getByRole("button", { name: "اعتماد المطالبة", exact: true }).click();
  await insu.page.locator("#cd-amount").fill("4000");
  await insu.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await insu.page.getByRole("button", { name: "تسجيل استلام التعويض" }).waitFor();
  await insu.page.getByRole("button", { name: "تسجيل استلام التعويض" }).click();
  await insu.page.locator("#cd-amount").fill("4000");
  await insu.page.locator('[data-testid="claim-file"]').setInputFiles(PDF_FILE);
  await insu.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await insu.page.getByText("بانتظار الإغلاق النهائي").first().waitFor();
  await insu.context.close();
  // repair documentation by the project manager through the documents section
  await pm2.page.reload();
  await waitDetail(pm2.page);
  await pm2.page.getByLabel("نوع المرفق").selectOption("REPAIR_COMPLETION");
  const [chooser] = await Promise.all([pm2.page.waitForEvent("filechooser"), pm2.page.getByRole("button", { name: "إرفاق", exact: true }).click()]);
  await chooser.setFiles(PDF_FILE);
  await pm2.page.waitForFunction(() => [...document.querySelectorAll("li")].some((li) => li.textContent.includes("إثبات إتمام الإصلاح")), null, { timeout: 15000 });
  const m2 = await openPage(browser, "manager");
  await m2.page.goto(`${BASE}/accidents/${life}`);
  await waitDetail(m2.page);
  await m2.page.getByRole("button", { name: "الإغلاق النهائي" }).click();
  await m2.page.locator("#mv-text").fill("اكتملت المطالبة وتم الإصلاح");
  check("closing dialog has nothing missing now", (await m2.page.getByText("المتطلبات الناقصة").count()) === 0);
  await m2.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await m2.page.getByText("مغلق", { exact: true }).first().waitFor();
  check("closed through the screens; the vehicle is restored", (await api.pm.call("GET", `/api/vehicles/${seed.ids.vehicle3}`)).body.data.status === "AVAILABLE");
  await shot(m2.page, "34-closed-case");
  // reopen from the screen
  await m2.page.getByRole("button", { name: "إعادة فتح" }).click();
  await m2.page.locator("#mv-text").fill("ظهر مستند جديد من شركة التأمين");
  await shot(m2.page, "35-reopen-dialog");
  await m2.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  await m2.page.getByTestId("returned-banner").waitFor();
  const banner = await m2.page.getByTestId("returned-banner").innerText();
  check("reopened from the screen: banner with the reason; vehicle flagged again", banner.includes("ظهر مستند جديد من شركة التأمين") && (await api.pm.call("GET", `/api/vehicles/${seed.ids.vehicle3}`)).body.data.status === "ACCIDENT");
  await shot(m2.page, "36-reopened-banner");
  await m2.context.close();

  // ───────── E. English ─────────
  const en = await openPage(browser, "manager", { locale: "en" });
  await en.page.goto(`${BASE}/accidents`);
  await en.page.getByRole("tab").first().waitFor();
  check("English: page is LTR with English tabs", (await en.page.evaluate(() => document.documentElement.dir)) === "ltr" && JSON.stringify(await tabs(en.page)) === JSON.stringify(["All accidents", "Awaiting assignment", "Returned for completion", "Drafts", "Insurance claims"]), JSON.stringify(await tabs(en.page)));
  check("English: KPI cards in English", (await en.page.getByText("Open accidents").count()) >= 1 && (await en.page.getByText("Awaiting assignment").count()) >= 1);
  await shot(en.page, "37-english-list");
  await en.page.goto(`${BASE}/accidents/${life}`);
  await en.page.getByText("Accident information").first().waitFor();
  const enText = await en.page.locator("main").innerText();
  check("English: case screen has English labels and none of the Arabic ones", enText.includes("Technical review") && enText.includes("Damage estimates") && enText.includes("Insurance claim") && !enText.includes("التقييم الفني") && !enText.includes("المطالبة التأمينية"));
  check("English: returned banner in English", (await en.page.getByTestId("returned-banner").innerText()).includes("Returned for completion"));
  await shot(en.page, "38-english-case");
  await en.page.goto(`${BASE}/accidents/settings`);
  await en.page.locator("#of-stage").waitFor();
  check("English: officers and delay limits in English", (await en.page.getByText("Delay limits").count()) >= 1 && (await en.page.getByText("Designated officers").count()) >= 1);
  await shot(en.page, "39-english-settings");
  await en.context.close();
  const enPm = await openPage(browser, "pm", { locale: "en" });
  await enPm.page.goto(`${BASE}/accidents/new`);
  await enPm.page.locator("#f-desc").waitFor();
  check("English: report form in English", (await enPm.page.getByText("Required documents").count()) >= 1 && (await enPm.page.getByText("Save as draft").count()) === 1);
  await shot(enPm.page, "40-english-form");
  await enPm.context.close();

  // ───────── F. documents on a phone: view and download ─────────
  const mob = await openPage(browser, "pm", { mobile: true });
  await mob.page.goto(`${BASE}/accidents/${life}`);
  await waitDetail(mob.page);
  const docLink = mob.page.locator('a[href*="/attachments/"][download]').first();
  await docLink.waitFor();
  const [download] = await Promise.all([mob.page.waitForEvent("download"), docLink.click()]);
  const p = await download.path();
  check("phone: a document downloads and is the real file", fs.readFileSync(p).subarray(0, 5).toString() === "%PDF-" && download.suggestedFilename().length > 0);
  check("phone: no horizontal overflow on the documents section", await noOverflow(mob.page));
  await shot(mob.page, "41-mobile-documents");
  await mob.context.close();
  const mobViewer = await openPage(browser, "viewer", { mobile: true });
  await mobViewer.page.goto(`${BASE}/accidents/${life}`);
  await waitDetail(mobViewer.page);
  const viewerLinks = await mobViewer.page.locator('a[href*="/attachments/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const hiddenId = (await api.pm.call("GET", `/api/accident-cases/${life}`)).body.data.attachments.find((a) => a.category === "DRIVER_ID").id;
  check("phone: the viewer sees no sensitive documents and cannot open one by address", !viewerLinks.some((h) => h.includes(hiddenId)) && (await mobViewer.page.request.get(`${BASE}/api/accident-cases/${life}/attachments/${hiddenId}/file`)).status() === 404);
  await shot(mobViewer.page, "42-mobile-viewer-documents");
  await mobViewer.context.close();

  // ───────── G. every role: tabs, lists, sidebar ─────────
  for (const role of Object.keys(EXPECTED_TABS)) {
    const ctxr = await openPage(browser, role);
    await ctxr.page.goto(`${BASE}/accidents`);
    await ctxr.page.getByText("الحوادث المسجلة").first().waitFor();
    await ctxr.page.waitForLoadState("networkidle");
    const got = await tabs(ctxr.page);
    check(`role ${role}: tabs`, JSON.stringify(got) === JSON.stringify(EXPECTED_TABS[role]), JSON.stringify(got));
    const navTexts = await ctxr.page.locator("nav a").allInnerTexts();
    const navHrefs = await ctxr.page.locator("nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    check(`role ${role}: sidebar has one Accidents entry (the finance-only menu has none, as before), no accident-cases/settings/officers/claims entries, at most one assignment tracking`, navTexts.filter((x) => x.trim() === "الحوادث").length === (role === "finance" ? 0 : 1) && navHrefs.filter((h) => /accident-cases|accidents\/settings|officers|claims|queue/.test(h ?? "")).length === 0 && navTexts.filter((x) => x.includes("متابعة الإسنادات")).length <= 1);
    check(`role ${role}: settings entry only for people who assign`, (await ctxr.page.getByRole("link", { name: "إدارة المسؤولين والمهل" }).count()) === (["manager", "sa"].includes(role) ? 1 : 0));
    let allOk = true;
    for (const name of got.filter((x) => x !== "جميع الحوادث")) {
      await ctxr.page.getByRole("tab", { name }).click();
      await ctxr.page.waitForLoadState("networkidle");
      const bad = await ctxr.page.getByRole("alert").count();
      if (bad) { allOk = false; console.log(`   tab ${name} shows an error for ${role}`); }
    }
    check(`role ${role}: every tab loads without an error`, allOk);
    await ctxr.context.close();
  }

  // ───────── H. legacy accident still works through its own screen ─────────
  const legacy = await api.pm.call("POST", "/api/accidents", { vehicleId: seed.ids.vehicle2, occurredAt: new Date(Date.now() - 5400000).toISOString(), description: "حادث قديم لاختبار القبول", severity: "MINOR" });
  const pm3 = await openPage(browser, "pm");
  await pm3.page.goto(`${BASE}/accidents/${legacy.body.data.id}`);
  await pm3.page.getByText("تفاصيل الحادث").first().waitFor();
  await pm3.page.getByRole("button", { name: /نقل إلى/ }).first().click();
  await pm3.page.getByRole("dialog").getByRole("button", { name: "تأكيد" }).click();
  let moved = false;
  for (let i = 0; i < 40 && !moved; i++) { moved = (await api.pm.call("GET", `/api/accidents/${legacy.body.data.id}`)).body.data.status === "UNDER_REVIEW"; if (!moved) await pm3.page.waitForTimeout(250); }
  check("legacy accident: status moved through its own screen", moved);
  await pm3.context.close();

  // ───────── I. concurrency and file protection from the outside ─────────
  const q1 = (await api.pm.call("POST", "/api/accident-cases", { vehicleId: seed.ids.vehicle2, occurredAt: new Date(Date.now() - 1800000).toISOString(), description: "حادث لاختبار التزامن والإسناد", severity: "MINOR" })).body.data.id;
  for (const c of DOC_CATS) await api.pm.upload(`/api/accident-cases/${q1}/attachments?category=${c}`, `${c}.pdf`);
  const submits = await Promise.all([1, 2, 3].map(() => api.pm.call("POST", `/api/accident-cases/${q1}/submit`)));
  check("concurrent submits: exactly one wins", JSON.stringify(submits.map((r) => r.status).sort()) === JSON.stringify([200, 409, 409]));
  const assigns = await Promise.all([api.manager.call("POST", `/api/accident-cases/${q1}/assign`, { userId: seed.ids.tech3User }), api.sa.call("POST", `/api/accident-cases/${q1}/assign`, { userId: seed.ids.tech3User })]);
  check("concurrent identical assignments: one wins, the other is told it is already assigned", JSON.stringify(assigns.map((r) => r.status).sort()) === JSON.stringify([200, 409]));
  const missing = await api.viewer.call("GET", `/api/accident-cases/${life}/attachments/${crypto.randomUUID()}/file`);
  const hidden = await api.viewer.call("GET", `/api/accident-cases/${life}/attachments/${hiddenId}/file`);
  check("a hidden file answers exactly like a missing one", hidden.status === 404 && missing.status === 404 && JSON.stringify(hidden.body) === JSON.stringify(missing.body));
  const driverOther = await api.driver.call("GET", `/api/accident-cases/${life}/attachments/${hiddenId}/file`);
  check("the driver cannot open someone else's sensitive document", driverOther.status === 404 || driverOther.status === 200 && false);
  await pm.context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    if (MODE === "off") await phaseOff(browser);
    else if (MODE === "accept") await phaseAccept(browser);
    else await phaseOn(browser);
  } catch (e) {
    check(`script completed (${e.message.split("\n")[0]})`, false);
    console.error(e);
  } finally {
    await browser.close();
  }
  check("no page errors or console errors", errors.length === 0, errors.slice(0, 5).join(" | "));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
