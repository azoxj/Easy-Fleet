# Easy Fleet — تقرير Sprint 2 / Part 1

**النتيجة: ✅ PASS — 143 / 143 اختبار (الخادم 126 + الواجهة 17) · Typecheck ✅ · Build ✅**

## 1) الوحدات المنفذة
| الوحدة | الحالة |
|---|---|
| الموظفون (CRUD، بحث، فلترة بالمشروع والحالة، أرشفة، إخفاء الهوية/الإقامة) | ✅ |
| السائقون (مرتبط بموظف، رخصة، حالة EXPIRED محسوبة، تنبيه قرب الانتهاء، سجل المركبات) | ✅ |
| إسناد السائق للمركبة (مع سجل تاريخي وقيود المشروع/الرخصة/مركبة واحدة) | ✅ |
| مستندات المركبة العامة (LICENSE/WARRANTY/OWNERSHIP/OTHER) مع حذف ناعم | ✅ |
| الاستمارة (استمارة حالية واحدة بقيد DB، تجديد يحفظ السجل) | ✅ |
| التأمين (وثيقة حالية واحدة، تجديد، نوع التغطية، القسط) | ✅ |
| المرفقات (رفع/تنزيل خاص مع فحص نوع الملف الحقيقي) | ✅ |
| ملف المركبة: نظرة عامة + تنبيهات + الاستمارة + التأمين + المستندات + السجل الزمني | ✅ |
| لوحة التحكم: عدد العناصر المنتهية/القريبة من الانتهاء (حقيقي، ضمن النطاق) | ✅ |
| الواجهة: Toasts، نوافذ تأكيد، تحقق النماذج، جداول تتحول إلى بطاقات على الجوال | ✅ |

## 2) Migration
`server/drizzle/0002_employees_drivers_vehicle_documents.sql` (جديدة؛ لم تُعدّل migrations سابقة)
- جداول جديدة: `files`, `vehicle_documents`, `insurance_policies`, `vehicle_driver_history`
- توسيع `employees` و`drivers`، وعمود `audit_logs.vehicle_id`
- enums جديدة: `vehicle_document_type`, `insurance_coverage_type`, `license_type`؛ وتحديث `employee_status`
- أعيدت كتابتها يدويًا لتكون آمنة للبيانات: `RENAME COLUMN` بدل الحذف والإضافة، وتحويل الحالات القديمة (ON_LEAVE→INACTIVE، TERMINATED→ARCHIVED). تم التحقق عليها بقاعدة تحتوي بيانات قديمة، و`drizzle-kit generate` بعدها يعطي «No schema changes».

## 3) API Routes الجديدة
| Method | Path | الصلاحية |
|---|---|---|
| GET | /employees · /employees/:id | employees.read (نطاق) |
| POST | /employees | employees.create |
| PATCH | /employees/:id | employees.update |
| POST | /employees/:id/archive | employees.archive |
| GET | /drivers · /drivers/:id | drivers.read |
| POST | /drivers | drivers.create |
| PATCH | /drivers/:id | drivers.update |
| POST | /drivers/:id/archive | drivers.archive |
| PUT | /vehicles/:id/driver | vehicles.update (PROJECT/ALL) + drivers.read |
| GET | /vehicles/:id/compliance | vehicles.read (+ أجزاء حسب الصلاحية) |
| GET/POST | /vehicles/:id/documents | vehicle_documents.read / create |
| PATCH/DELETE | /vehicle-documents/:id | vehicle_documents.update (أو registration.update) / vehicle_documents.delete |
| PUT/GET | /vehicle-documents/:id/file | update / read حسب نوع المستند |
| GET/POST | /vehicles/:id/registration | registration.read / create |
| GET/POST | /vehicles/:id/insurance | insurance.read / create |
| PATCH | /insurance/:id | insurance.update |
| PUT/GET | /insurance/:id/file | insurance.update / insurance.read |
| GET | /vehicles/:id/timeline | vehicles.read (مطوّر: وصف عربي، actor، entity) |

## 4) الصلاحيات الجديدة ومنحها
| الصلاحية | SUPER_ADMIN | PROJECT_MANAGER | FINANCE | TECHNICAL | USER | DRIVER | VIEWER |
|---|---|---|---|---|---|---|---|
| employees.read | ALL | PROJECT | — | — | — | ASSIGNED (سجله) | — |
| employees.create / update | ALL | PROJECT | — | — | — | — | — |
| employees.archive | ALL | — | — | — | — | — | — |
| drivers.read | ALL | PROJECT | — | — | — | ASSIGNED | — |
| drivers.create / update | ALL | PROJECT | — | — | — | — | — |
| drivers.archive | ALL | — | — | — | — | — | — |
| vehicle_documents.read | ALL | PROJECT | ALL | PROJECT | PROJECT | ASSIGNED | PROJECT |
| vehicle_documents.create / update | ALL | PROJECT | — | — | — | — | — |
| vehicle_documents.delete | ALL | — | — | — | — | — | — |
| registration.read | ALL | PROJECT | ALL | PROJECT | PROJECT | ASSIGNED | PROJECT |
| registration.create / update | ALL | PROJECT | — | — | — | — | — |
| insurance.read | ALL | PROJECT | ALL | PROJECT | — | ASSIGNED | PROJECT |
| insurance.create / update | ALL | PROJECT | — | — | — | — | — |

## 5) الاختبارات
### الخادم — 126/126 (14 ملفًا؛ منها 56 جديدًا)
| الملف | العدد | يغطي |
|---|---|---|
| employees.test.ts | 10 | CRUD + تدقيق، 400/409، 401/404/400 للمعرفات، 403 للأدوار، عزل المشاريع (قراءة/تعديل/أرشفة)، منع تغيير projectId، رفض الحقول غير المعروفة، إخفاء الهوية في القوائم والبحث والتفاصيل، ربط الحساب للمدير فقط، منع أرشفة/نقل سائق يقود مركبة |
| drivers.test.ts | 11 | الإنشاء من موظف ضمن النطاق، علاقة 1:1، التحقق، EXPIRED محسوب بساعة الخادم، التعديل والأرشفة، 401/403/404، عزل المشاريع، السائق يرى ملفه فقط، إسناد المركبة + السجل + الإشعار + الـTimeline، قيود المشروع/الرخصة/مركبة واحدة، إخفاء مركبات خارج النطاق في السجل |
| documents.test.ts | 17 | الاستمارة (إضافة/تجديد/سجل/قيد DB/تحقق/رفض status من العميل/عزل)، التأمين (تجديد، تحقق، تكرار، أمان #3، FINANCE/DRIVER)، المستندات العامة، أمان #5 بدور مخصص محدود بالمشروع، IDOR، الملفات (رفع/تنزيل، أمان #7، رفض ملفات مموهة/فارغة/كبيرة/غير مطابقة، CSRF)، ملخص الامتثال، الـTimeline |
| expiry.test.ts | 4 | حدود القاعدة بدقة، المنطقة الزمنية، حساب التواريخ، الحالة الفعلية للسائق |
| sprint2-permissions.test.ts | 4 | مبدأ أقل صلاحية، أمان #6، أمان #8، عدادات لوحة التحكم ضمن النطاق |

### الواجهة — 17/17 (4 ملفات)
عميل رفع الملفات (CSRF، ترميز الاسم، الأخطاء)، التنقل حسب الصلاحيات، تغطية التسميات لكل قيم enums.

### اختبارات الأمان الإلزامية
| # | الاختبار | النتيجة |
|---|---|---|
| 1 | مستخدم A لا يرى موظف B | ✅ 404 |
| 2 | مستخدم A لا يعدّل موظف B | ✅ 404 (والبيانات لم تتغير) |
| 3 | مستخدم A لا يرى تأمين مركبة B | ✅ 404 (قراءة/تعديل/ملف) |
| 4 | لا يمكن تجاوز النطاق بـ projectId | ✅ 403 (موظف، مركبة، إسناد) |
| 5 | لا يمكن حذف مستند خارج النطاق | ✅ 404 لدور حذف محدود بالمشروع، 403 لمن لا يملك الصلاحية |
| 6 | المستخدم لا يمنح نفسه صلاحية | ✅ 403/400، ولا توجد API لتعديل الصلاحيات |
| 7 | لا وصول لملف بدون تفويض | ✅ 401 بلا جلسة، 404 خارج النطاق |
| 8 | لا بيانات حساسة في ردود غير مصرح بها | ✅ |

### تجربة المتصفح (Chromium)
الموظفون، السائقون، ملف سائق برخصة منتهية، ملف المركبة، رفع مرفق، تجديد استمارة، التأمين، المستندات، السجل الزمني، تغيير السائق (السائق ذو الرخصة المنتهية لا يظهر في الخيارات)، نطاق مدير المشروع، الجوال بدون أي horizontal overflow (0px)، بدون أخطاء Console.

## 6) Bugs اكتُشفت وأُصلحت أثناء التحقق
- الصلاحيات الجديدة لا تصل للأدوار في قاعدة موجودة دون `db:bootstrap` → أضيف `npm run db:setup` (migrate + bootstrap) وجعل الـseed يزامن الكتالوج دائمًا، ووُثّق في README.
- migration المولّدة آليًا كانت ستفقد بيانات (حذف/إضافة أعمدة، cast فاشل للـenum) → أعيدت كتابتها بشكل آمن.

## 7) خارج النطاق (Sprint قادم)
الصيانة، الوقود، الحوادث، المخالفات، التسليم والاستلام، المصروفات، نظام التنبيهات الكامل (البيانات والخدمة الأساسية جاهزة: `services/expiry.ts` + عدادات اللوحة).
