# Easy Fleet | إيزي فليت

نظام داخلي لإدارة المركبات والأسطول.

النظام متكامل ويغطي:

- **الأساس:** المصادقة بالجلسات، المستخدمون، الأدوار والصلاحيات بالنطاق (ALL / PROJECT / ASSIGNED)، المشاريع والأعضاء، الإسنادات بكل أنواعها، سجل تدقيق غير قابل للتعديل مع القيم السابقة/الجديدة، مركز إشعارات بفئات وتفضيلات، بحث شامل، ولوحة تحكم بمؤشرات ورسوم وتنبيهات من قاعدة البيانات.
- **الأسطول:** المركبات (لوحة عربية/إنجليزية، رقم تسلسلي، رمز QR)، الموظفون ومستنداتهم، السائقون ورخصهم، مستندات المركبة والاستمارة والتأمين، ومركز المستندات لكل ما له تاريخ انتهاء.
- **العمليات:** الصيانة الكاملة (فحص، قطع، عمالة، عروض أسعار، اعتماد، استلام)، التسليم والاستلام عبر رابط آمن للجوال (7 صور + توقيع + مقارنة الإرجاع)، الوقود وإحصاءات الاستهلاك، الحوادث، المخالفات، وتتبع GPS بالمتصفح مع خريطة الأسطول.
- **المالية:** الفواتير (مسودة ← مقدمة ← مراجعة ← اعتماد ← تحويل بإيصال ← مدفوعة)، المصروفات، لوحة المالية، والملخص المالي لكل مشروع (ميزانية، قيمة عقد، تكاليف، متبقٍ).
- **الإدارة:** مركز الاعتمادات، 12 تقريرًا مع فلاتر وتصدير CSV وطباعة PDF، إعدادات الشركة والنظام، الموردون، وتطبيق ويب قابل للتثبيت (PWA).

> نظام داخلي لشركة واحدة، مع تصميم قاعدة بيانات جاهز للتحول إلى Multi-Tenant SaaS لاحقًا
> (كل جدول مملوك للمنشأة يحمل `organization_id`، والقيمة تُستمد من الجلسة فقط).

## التقنيات

| الطبقة | التقنية |
|---|---|
| Frontend | React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · React Router 7 — عربي RTL ومتجاوب |
| Backend | Node.js 22 · TypeScript · Express 5 (REST) · Zod للتحقق |
| Database | PostgreSQL 16 |
| ORM | Drizzle ORM + drizzle-kit (migrations SQL) |
| Auth | جلسات على الخادم (Cookie HttpOnly + SameSite=Strict) + CSRF token · scrypt لتجزئة كلمات المرور |
| Tests | Vitest + Supertest على قاعدة PostgreSQL حقيقية للاختبار |

## الهيكل

```
easy-fleet/
├── server/
│   ├── drizzle/                 # migrations (SQL) — مصدرها src/db/schema
│   ├── src/
│   │   ├── auth/                # permissions catalog, access (scope), sessions, password
│   │   ├── db/                  # schema/*, client, bootstrap (sync catalog)
│   │   ├── http/                # middleware, errors, validation helpers
│   │   ├── modules/             # auth, users, roles, projects, vehicles, assignments, notifications,
│   │   │                        # audit, dashboard, search, employees, drivers, documents, vendors,
│   │   │                        # maintenance, finance (invoices, expenses, costs), operations (fuel,
│   │   │                        # accidents, violations, handover, qr, tracking), approvals, reports, settings
│   │   ├── services/            # audit, notifications, storage, expiry, timeline, jobs
│   │   ├── scripts/             # migrate, bootstrap, seed-demo, run-jobs
│   │   ├── app.ts / index.ts
│   └── tests/                   # 23 integration/security/E2E test files
├── web/
│   └── src/
│       ├── components/          # ui kit, charts (SVG), map (Leaflet), layout, shared helpers
│       ├── lib/                 # api client, auth context, permissions, labels, format
│       ├── pages/               # dashboard, fleet, maintenance, finance, operations, handover, tracking, admin
│       └── public/              # manifest, icons, service worker, offline page
└── docs/                        # SCHEMA.md · SECURITY.md · SPRINT-1-REPORT.md
```

## التشغيل محليًا

المتطلبات: Node.js ≥ 22.9 و PostgreSQL ≥ 15.

```bash
cd easy-fleet
npm install

# 1) قاعدة البيانات (مثال)
createuser -P easy_fleet
createdb -O easy_fleet easy_fleet
createdb -O easy_fleet easy_fleet_test

# 2) الإعدادات
cp server/.env.example server/.env      # ثم عدّل DATABASE_URL و TEST_DATABASE_URL

# 3) الجداول + الأدوار والصلاحيات (شغّلها بعد كل تحديث للنظام)
npm run db:setup                        # = db:migrate ثم db:bootstrap (آمن للتكرار)

# 4) أول مدير نظام (مرة واحدة) — لا تحفظ كلمة المرور في Git
BOOTSTRAP_ADMIN_EMAIL=admin@your-company.example BOOTSTRAP_ADMIN_PASSWORD='...' npm run db:bootstrap

# (اختياري) بيانات تجريبية واضحة للتجربة فقط — ترفض العمل في production
npm run db:seed:demo

# (اختياري) مهام التنبيهات والتنظيف يدويًا — تعمل تلقائيًا داخل الخادم كل 6 ساعات ما لم DISABLE_JOBS=true
npm run jobs:run -w server

# 5) التشغيل
npm run dev:server     # http://localhost:4000/api
npm run dev:web        # http://localhost:5173 (يمرر /api إلى الخادم)
```

### التحديث إلى إصدار جديد

```bash
git pull && npm ci
npm run db:setup       # يطبق migrations الجديدة ويزامن الصلاحيات الجديدة مع الأدوار
```

> مهم: الصلاحيات الجديدة لا تصل للأدوار إلا بعد `db:bootstrap` (ضمن `db:setup`).

### الإنتاج

```bash
npm run build
# ثم على الخادم (خلف HTTPS):
NODE_ENV=production COOKIE_SECURE=true WEB_DIST_DIR=../web/dist APP_ORIGINS=https://fleet.example \
  node --env-file=.env server/dist/index.js
```

يخدم الخادم الواجهة المبنية من نفس الـ origin (أبسط وأأمن مع SameSite=Strict).

متغيرات إضافية اختيارية: `PUBLIC_APP_URL` (عنوان روابط التسليم ورموز QR)، `HANDOVER_LINK_DAYS`، `MAP_TILE_URL`
(مزود خرائط بمفتاح — يمر عبر الخادم ولا يصل المفتاح للمتصفح)، `MAP_ATTRIBUTION`، `MAP_DEFAULT_CENTER`، `DISABLE_JOBS`.
عند تعدد النسخ: حدود المعدل الحساسة مشتركة عبر PostgreSQL، أما الملفات فعلى القرص المحلي (انظر SECURITY.md).

### النشر على Render (Preview)

انظر [docs/DEPLOYMENT-RENDER.md](docs/DEPLOYMENT-RENDER.md) و [`render.yaml`](render.yaml):
Build `npm ci --include=dev && npm run build` · Pre-deploy `npm run db:setup` · Start `npm run start -w server` ·
Health `/api/healthz` · Readiness `/api/readyz`.

## الاختبارات

```bash
npm test               # server (195) + web (31)
npm run typecheck
```

اختبارات الخادم تعيد بناء قاعدة `TEST_DATABASE_URL` من الـ migrations الحقيقية في كل تشغيل، وترفض العمل على قاعدة ليست للاختبار.

## الوثائق

- [docs/SCHEMA.md](docs/SCHEMA.md) — مخطط قاعدة البيانات
- [docs/SECURITY.md](docs/SECURITY.md) — نموذج الصلاحيات وملاحظات الأمان
- [docs/SPRINT-1-REPORT.md](docs/SPRINT-1-REPORT.md) — تقرير Sprint 1
- [docs/SPRINT-2-PART-1-REPORT.md](docs/SPRINT-2-PART-1-REPORT.md) — تقرير Sprint 2 / Part 1
- [docs/SPRINT-2-PART-2-REPORT.md](docs/SPRINT-2-PART-2-REPORT.md) — تقرير Sprint 2 / Part 2 (الصيانة)
- [docs/FULL-SYSTEM-REPORT.md](docs/FULL-SYSTEM-REPORT.md) — تقرير النظام المتكامل والاختبارات النهائية
