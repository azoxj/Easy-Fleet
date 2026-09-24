# Easy Fleet | إيزي فليت

نظام داخلي لإدارة المركبات والأسطول — **المرحلة الأولى: Sprint 1** (الأساس: المصادقة، المستخدمون، الأدوار والصلاحيات، المشاريع، الإسنادات، المركبات، لوحة التحكم، سجل التدقيق، الإشعارات).

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
│   │   ├── modules/             # auth, users, roles, projects, vehicles, assignments,
│   │   │                        # notifications, audit, dashboard, search
│   │   ├── services/            # audit, notifications
│   │   ├── scripts/             # migrate, bootstrap, seed-demo
│   │   ├── app.ts / index.ts
│   └── tests/                   # 9 integration/unit test files
├── web/
│   └── src/
│       ├── components/          # ui kit, icons, layout (sidebar/topbar/search/notifications)
│       ├── lib/                 # api client, auth context, permissions, labels, format
│       └── pages/               # dashboard, projects, vehicles, users, roles, assignments, ...
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

# 3) الجداول + الأدوار والصلاحيات
npm run db:migrate
npm run db:bootstrap                    # يزامن المنشأة والصلاحيات والأدوار (آمن للتكرار)

# 4) أول مدير نظام (مرة واحدة) — لا تحفظ كلمة المرور في Git
BOOTSTRAP_ADMIN_EMAIL=admin@your-company.example BOOTSTRAP_ADMIN_PASSWORD='...' npm run db:bootstrap

# (اختياري) بيانات تجريبية واضحة للتجربة فقط — ترفض العمل في production
npm run db:seed:demo

# 5) التشغيل
npm run dev:server     # http://localhost:4000/api
npm run dev:web        # http://localhost:5173 (يمرر /api إلى الخادم)
```

### الإنتاج

```bash
npm run build
# ثم على الخادم (خلف HTTPS):
NODE_ENV=production COOKIE_SECURE=true WEB_DIST_DIR=../web/dist APP_ORIGINS=https://fleet.example \
  node --env-file=.env server/dist/index.js
```

يخدم الخادم الواجهة المبنية من نفس الـ origin (أبسط وأأمن مع SameSite=Strict).

## الاختبارات

```bash
npm test               # server (80) + web (12)
npm run typecheck
```

اختبارات الخادم تعيد بناء قاعدة `TEST_DATABASE_URL` من الـ migrations الحقيقية في كل تشغيل، وترفض العمل على قاعدة ليست للاختبار.

## الوثائق

- [docs/SCHEMA.md](docs/SCHEMA.md) — مخطط قاعدة البيانات (المنفذ + المقترح للـ Sprints القادمة)
- [docs/SECURITY.md](docs/SECURITY.md) — نموذج الصلاحيات وملاحظات الأمان
- [docs/SPRINT-1-REPORT.md](docs/SPRINT-1-REPORT.md) — تقرير Sprint 1
