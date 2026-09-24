# Easy Fleet — تقرير Sprint 1

**النتيجة الإجمالية: ✅ PASS — 92 / 92 اختبار ناجح (الخادم 80 + الواجهة 12)، Typecheck ✅، Build ✅**

## 1) ما تم تنفيذه

| # | البند | الحالة |
|---|---|---|
| 1 | إعداد المشروع (npm workspaces: server + web، TypeScript strict) | ✅ |
| 2 | مخطط PostgreSQL + migrations (Drizzle) مع FKs وindexes وCHECKs | ✅ |
| 3 | المصادقة: جلسات آمنة، scrypt، CSRF، rate limiting، إجبار تغيير كلمة المرور | ✅ |
| 4 | المستخدمون: إنشاء، تعديل، تعطيل، إعادة تعيين كلمة المرور، تغيير الأدوار | ✅ |
| 5 | الأدوار السبعة المدمجة | ✅ |
| 6 | الصلاحيات بنطاقات ALL / PROJECT / ASSIGNED + مصفوفة عرض | ✅ |
| 7 | المشاريع: إنشاء، تعديل (حقول حساسة للإدارة فقط)، تفاصيل | ✅ |
| 8 | إسناد المشاريع (العضوية) + كيان Assignment + صفحة «إسناداتي» | ✅ |
| 9 | المركبات: CRUD مقيّد بالنطاق، أرشفة، سجل زمني، 11 تبويبًا (2 مفعّلة) | ✅ |
| 10 | لوحة تحكم حسب الدور (مدير نظام / مدير مشروع / مالية / سائق / عام) | ✅ |
| 11 | أساس سجل التدقيق (append-only بقيد في قاعدة البيانات) | ✅ |
| 12 | أساس الإشعارات (مركز إشعارات + جرس + منع التسرب بين المستخدمين والمشاريع) | ✅ |

## 2) Migrations

| الملف | المحتوى |
|---|---|
| `server/drizzle/0000_init.sql` | 10 enums + 15 جدولًا: organizations, users, roles, permissions, role_permissions, user_roles, sessions, projects, project_users, employees, drivers, vehicles, assignments, notifications, audit_logs |
| `server/drizzle/0001_audit_log_append_only.sql` | دالة + triggers تمنع UPDATE/DELETE/TRUNCATE على audit_logs |

## 3) REST API Routes (`/api`)

| Method | Path | الصلاحية |
|---|---|---|
| GET | /health | عام |
| POST | /auth/login · /auth/logout · /auth/change-password | — / جلسة |
| GET | /auth/me | جلسة |
| GET | /dashboard | dashboard.view |
| GET | /users · /users/:id · /users/lookup/active | users.read (نطاق) |
| POST | /users · /users/:id/reset-password | users.manage (ALL) |
| PATCH | /users/:id | users.manage (ALL) |
| PUT | /users/:id/roles | users.manage (ALL) + منع التصعيد |
| GET | /roles · /roles/permissions | roles.read |
| GET | /projects · /projects/:id · /projects/:id/members | projects.read (نطاق) |
| POST | /projects | projects.create (ALL) |
| PATCH | /projects/:id | projects.update (نطاق؛ الحقول الحساسة ALL) |
| POST / DELETE | /projects/:id/members · /projects/:id/members/:userId | projects.members.manage |
| GET | /vehicles · /vehicles/:id · /vehicles/:id/timeline | vehicles.read (نطاق) |
| POST | /vehicles | vehicles.create (نطاق المشروع الهدف) |
| PATCH | /vehicles/:id | vehicles.update (نطاق + حقول محدودة لـ ASSIGNED) |
| POST | /vehicles/:id/archive | vehicles.archive |
| GET | /assignments/mine | جلسة (ذاتي) |
| GET | /assignments | ذاتي + assignments.read (نطاق) |
| POST | /assignments | assignments.create (PROJECT/VEHICLE/TASK) |
| PATCH | /assignments/:id/status | المسند إليه للتقدم؛ المُسند/assignments.manage للإلغاء |
| GET | /notifications · /notifications/unread-count | جلسة (ذاتي) |
| POST | /notifications/:id/read · /notifications/read-all | جلسة (ذاتي) |
| GET | /audit-logs | audit.read |
| GET | /search | نطاق vehicles.read / projects.read |

## 4) نتائج الاختبارات

### الخادم — `npm test -w server` → **PASS: 80/80** (9 ملفات)

| الملف | العدد | يغطي |
|---|---|---|
| auth.test.ts | 18 | Cookie آمن، تخزين hash للتوكن، رسائل خطأ موحدة، المعطلون، rate limit (حساب + IP)، CSRF، Origin، إجبار تغيير كلمة المرور وإبطال الجلسات، انتهاء الجلسة، تدقيق الدخول، Security headers، JSON خاطئ/كبير، 404 |
| users-rbac.test.ts | 13 | تطابق الأدوار مع الكتالوج، دمج الأدوار، إنشاء مستخدم بكلمة مؤقتة، تكرار البريد، منع غير المدراء، رفض الحقول غير المعروفة، منع تعديل الذات، سريان الأدوار فورًا، التعطيل يبطل الجلسات، إعادة التعيين، نطاق مدير المشروع |
| projects.test.ts | 10 | الإنشاء + إشعار المدير + التدقيق، القيود (تكرار/تواريخ/ميزانية سالبة)، عزل المشاريع (404)، الحقول الحساسة، المشاهد، السائق، إدارة الأعضاء |
| vehicles.test.ts | 11 | الإنشاء، التحقق والتفرد، عزل المشاريع (IDOR)، منع النقل لمشروع آخر، العداد لا ينقص، الأرشفة، رؤية السائق للمسند فقط وإبطالها عند نقل المركبة، الفني (ASSIGNED)، المالية قراءة فقط، السجل الزمني |
| assignments.test.ts | 9 | إسناد مهمة + إشعار، رفض غير الأعضاء والمشاريع خارج النطاق، رفض projectId متعارض، الإسناد لا يمنح صلاحية عامة، سير الحالات، عزل القوائم |
| notifications.test.ts | 5 | عدم رؤية/تعديل إشعارات الآخرين، منع التسرب بين المشاريع، المعطلون والمنشآت الأخرى، الروابط الداخلية فقط |
| audit.test.ts | 4 | الـ trigger يمنع UPDATE/DELETE/TRUNCATE، إخفاء الأسرار، القراءة للمدير فقط، الفلترة |
| dashboard-search.test.ts | 5 | لوحة لكل دور بلا أرقام وهمية، أرقام مدير المشروع ضمن نطاقه، السائق، البحث المقيّد |
| password.test.ts | 5 | صيغة الـ hash والملح، رفض الخطأ، ترقية المعاملات، سياسة كلمة المرور |

### الواجهة — `npm test -w web` → **PASS: 12/12** (3 ملفات)
api client (CSRF على الكتابة فقط، معالجة 401، إجبار تغيير كلمة المرور)، مساعدات الصلاحيات والقائمة، التنسيق وأخطاء الحقول.

### فحوصات أخرى
- `npm run typecheck` (server + web): ✅
- `npm run build` (server tsc + web vite): ✅
- تجربة End-to-End في Chromium (Playwright) مع بيانات تجريبية: دخول، لوحات 3 أدوار، المركبات، تعديل + السجل الزمني، المشاريع، إنشاء مستخدم بكلمة مؤقتة، المصفوفة، سجل التدقيق، البحث، واجهة الجوال للسائق، الإشعارات — تم التحقق من أن مدير المشروع لا يرى إلا مركبات مشروعه ولا يصل لسجل التدقيق. (تم اكتشاف وإصلاح خلل في حجم الأيقونات أثناء التجربة.)

## 5) ما تبقى / مؤجل عمدًا
- CRUD الموظفين والسائقين (الجداول موجودة؛ ربط `assignedDriverId` من الواجهة مؤجل لوحدة التسليم).
- تعديل مصفوفة الصلاحيات والأدوار المخصصة من الواجهة (العرض فقط الآن).
- تنبيهات انتهاء المستندات (تتطلب وحدة الاستمارات/التأمين).
- التخزين (رفع الملفات) — مع أول وحدة تتطلبه.
- `seed-demo` يُدخل البيانات مباشرة، لذا لا تظهر أحداث «إنشاء» للبيانات التجريبية في السجل الزمني.
