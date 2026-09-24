# Easy Fleet — تقرير Sprint 2 / Part 2 (نظام الصيانة)

**النتيجة: ✅ PASS — 183/183 اختبار (الخادم 156 + الواجهة 27) · Typecheck ✅ · Build ✅ · تجربة المتصفح 37/37 ✅**

## Migration
`server/drizzle/0003_maintenance_workflow.sql` — إضافية فقط (لم تُعدّل 0000–0002). جداول: `vendors`, `maintenance_requests`, `maintenance_parts`, `maintenance_labor`, `maintenance_quotes`, `maintenance_attachments`, `maintenance_events` + trigger يمنع تعديل/حذف `maintenance_events`. `drizzle-kit generate` بعدها: «No schema changes».

## State machine (السيرفر فقط)
| الإجراء | من | إلى | الصلاحية | شرط إضافي |
|---|---|---|---|---|
| start-inspection | REQUESTED | INSPECTION | maintenance.update | — |
| complete-inspection | INSPECTION | QUOTE_PENDING | maintenance.update | فني مسند + تشخيص |
| (نظام) تقديم عرض | QUOTE_PENDING | PENDING_APPROVAL | — | تلقائي |
| (نظام) رفض آخر عرض | PENDING_APPROVAL | QUOTE_PENDING | — | تلقائي |
| approve | PENDING_APPROVAL | APPROVED | maintenance.approve | عرض سعر معتمد |
| reject | REQUESTED…PENDING_APPROVAL | REJECTED | maintenance.reject | سبب إلزامي |
| start-repair | APPROVED | IN_REPAIR | maintenance.update | فني مسند؛ المركبة → IN_MAINTENANCE |
| mark-ready | IN_REPAIR | READY_FOR_HANDOVER | maintenance.update | الأعمال المنفذة |
| accept-handover | READY_FOR_HANDOVER | ACCEPTED (→ CLOSED إن كان لديه close) | maintenance.handover | استعادة حالة المركبة |
| reject-handover | READY_FOR_HANDOVER | IN_REPAIR | maintenance.handover | سبب إلزامي |
| close | ACCEPTED | CLOSED | maintenance.close | — |
| assign | REQUESTED…IN_REPAIR | (بدون تغيير) | maintenance.assign | الفني يملك maintenance.update وعضو بالمشروع |

## عروض الأسعار
DRAFT → SUBMITTED (maintenance.quote.create) → UNDER_REVIEW (quote.approve) → APPROVED (quote.approve) / REJECTED (quote.reject + سبب). اعتماد عرض يرفض باقي العروض المفتوحة تلقائيًا؛ عرض معتمد واحد فقط (قيد DB)؛ لا يُقدَّم/يُعتمد عرض منتهي الصلاحية.

## الصلاحيات
| الصلاحية | SUPER_ADMIN | PM | FINANCE | TECHNICAL | USER | VIEWER | DRIVER |
|---|---|---|---|---|---|---|---|
| maintenance.read | ALL | PROJECT | ALL | ASSIGNED | PROJECT | PROJECT | — |
| create / update / assign / approve / reject / handover / close | ALL | PROJECT | — | update فقط: ASSIGNED | — | — | — |
| quote.read / quote.create | ALL | PROJECT | read: ALL | ASSIGNED | — | — | — |
| quote.approve / quote.reject | ALL | — | ALL | — | — | — | — |
| parts.read/manage · labor.read/manage | ALL | PROJECT | read: ALL | ASSIGNED | — | — | — |

## الاختبارات
- `maintenance.test.ts` (15): المسار الكامل مع الإشعارات والأحداث والتدقيق والتكاليف وحالة المركبة، رفض الاستلام، رفض العروض والعودة لـ QUOTE_PENDING، الاعتماد التلقائي، التحقق، القبول بدون صلاحية الإغلاق، البحث والفلاتر، قيود الحقول، القطع والعمالة، قيود DB، الموردون، المرفقات، ملخص المركبة، مؤشرات اللوحة.
- `maintenance-security.test.ts` (15): البنود الأمنية الـ16 كلها + مصفوفة كاملة لكل انتقال غير مسموح (>70 حالة → 409).
- الواجهة (10 جديدة): التسميات، الإجراءات، الـStepper، التحقق من النماذج، الصلاحيات في القائمة، رفع المرفقات.

## تجربة المتصفح (37/37)
السيناريو الكامل عبر الواجهة (PM ينشئ → الفني يُشعَر → فحص → تشخيص → قطعة وعمالة → عرض سعر → المالية تعتمد → PM يعتمد → إصلاح → جاهزة → PM يقبل → CLOSED)، وسيناريو رفض الاستلام (السبب إلزامي → IN_REPAIR → إشعار الفني)، رؤية كل دور (SUPER_ADMIN, PM, TECHNICAL, FINANCE, DRIVER)، الجوال بدون overflow، بدون أخطاء Console.

## Bugs اكتُشفت وأُصلحت
1. الفنيون (نطاق ASSIGNED) لم يظهروا كمرشحين للإسناد → تصحيح `permissionHolders`.
2. تكلفة «هذا الشهر» كانت تعتمد `now()` من قاعدة البيانات لا ساعة الخادم → توحيدها مع `today()`.
3. subquery مرتبط في Drizzle يولّد عمود `"id"` غير مؤهل داخل استعلام جدول واحد (تكلفة = 0) → مرجع صريح `"maintenance_requests"."id"`.

## قيود معروفة
- الصيانة الدورية المخططة غير منفذة (تظهر كـ placeholder).
- لا يوجد lint script في المشروع (لم يُضف ESLint لتجنب مكتبات غير مطلوبة).
- لا تُحذف المرفقات بعد الرفع (تبقى للتدقيق).
- التكلفة = القطع + العمالة الفعلية؛ ربطها بالفواتير يأتي مع وحدة المالية.
