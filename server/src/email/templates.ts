/**
 * Arabic, right-to-left email templates (HTML + plain-text alternative).
 * Table layout + inline styles for mail clients; every dynamic value is
 * HTML-escaped. Emails are Arabic by product decision (see docs/EMAIL.md).
 * Templates never contain passwords; the reset link is the only secret and
 * exists only in the message itself (never logged or stored).
 */

import { config } from "../config.js";

export type Rendered = { subject: string; html: string; text: string };
export type Brand = { appUrl: string; supportEmail: string | null };

const BRAND = "#1d4ed8";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(b: Brand, o: { preheader: string; heading: string; paragraphs: string[]; button?: { label: string; url: string }; notes?: string[]; footerNote?: string }): string {
  const p = o.paragraphs.map((x) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.8;color:#1e293b">${x}</p>`).join("");
  const button = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="border-radius:10px;background:${BRAND}"><a href="${esc(o.button.url)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${esc(o.button.label)}</a></td></tr></table>
       <p style="margin:0 0 16px;font-size:12px;line-height:1.7;color:#64748b">إذا لم يعمل الزر، انسخ الرابط التالي والصقه في المتصفح:<br><span dir="ltr" style="word-break:break-all;color:${BRAND}">${esc(o.button.url)}</span></p>`
    : "";
  const notes = (o.notes ?? []).map((x) => `<p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:#92400e">${x}</p>`).join("");
  const noteBox = notes ? `<div style="margin:18px 0 0;padding:14px 16px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a">${notes}</div>` : "";
  const support = b.supportEmail ? `للمساعدة تواصل معنا على <a href="mailto:${esc(b.supportEmail)}" style="color:${BRAND}" dir="ltr">${esc(b.supportEmail)}</a>` : "للمساعدة تواصل مع مسؤول النظام في شركتك.";
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;direction:rtl">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;font-family:Tahoma,'Segoe UI',Arial,sans-serif;text-align:right" dir="rtl">
<tr><td style="background:${BRAND};padding:20px 28px">
  <span style="font-size:20px;font-weight:800;color:#ffffff">إيزي فليت</span>
  <span style="font-size:13px;color:#bfdbfe;margin-right:8px" dir="ltr">Easy Fleet</span>
</td></tr>
<tr><td style="padding:28px">
  <h1 style="margin:0 0 18px;font-size:20px;line-height:1.6;color:#0f172a">${esc(o.heading)}</h1>
  ${p}${button}${noteBox}
</td></tr>
<tr><td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.8;color:#64748b">
  ${support}<br>${o.footerNote ?? "هذه رسالة آلية من نظام إيزي فليت لإدارة الأساطيل، يرجى عدم الرد عليها."}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const textOf = (lines: (string | null | undefined | false)[]) => lines.filter(Boolean).join("\n\n");
const supportLine = (b: Brand) => (b.supportEmail ? `للمساعدة: ${b.supportEmail}` : "للمساعدة تواصل مع مسؤول النظام في شركتك.");
const formatWhen = (d: Date) => new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { dateStyle: "long", timeStyle: "short", timeZone: config.APP_TIMEZONE }).format(d);

export function passwordResetEmail(b: Brand, o: { name: string; link: string; minutes: number }): Rendered {
  const subject = "إعادة تعيين كلمة المرور - Easy Fleet";
  return {
    subject,
    html: layout(b, {
      preheader: "رابط إعادة تعيين كلمة المرور لحسابك في إيزي فليت",
      heading: "إعادة تعيين كلمة المرور",
      paragraphs: [`مرحبًا ${esc(o.name)}،`, "تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك في إيزي فليت. اضغط على الزر التالي لاختيار كلمة مرور جديدة:"],
      button: { label: "إعادة تعيين كلمة المرور", url: o.link },
      notes: [
        `ينتهي هذا الرابط خلال <b>${o.minutes} دقيقة</b> ويمكن استخدامه مرة واحدة فقط.`,
        "إذا لم تطلب إعادة تعيين كلمة المرور فتجاهل هذه الرسالة؛ ستبقى كلمة المرور الحالية كما هي.",
        "لن نطلب منك كلمة المرور أبدًا عبر البريد أو الهاتف. لا تشارك هذا الرابط مع أي شخص.",
      ],
    }),
    text: textOf([`مرحبًا ${o.name}،`, "تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك في إيزي فليت. افتح الرابط التالي لاختيار كلمة مرور جديدة:", o.link, `ينتهي الرابط خلال ${o.minutes} دقيقة ويمكن استخدامه مرة واحدة فقط.`, "إذا لم تطلب ذلك فتجاهل هذه الرسالة؛ ستبقى كلمة المرور الحالية كما هي. لا تشارك هذا الرابط مع أي شخص.", supportLine(b)]),
  };
}

export function passwordChangedEmail(b: Brand, o: { name: string; when: Date; byAdmin?: boolean }): Rendered {
  const subject = "تم تغيير كلمة المرور - Easy Fleet";
  const how = o.byAdmin ? "أعاد مسؤول النظام تعيين كلمة المرور لحسابك" : "تم تغيير كلمة المرور لحسابك";
  return {
    subject,
    html: layout(b, {
      preheader: how,
      heading: "تم تغيير كلمة المرور",
      paragraphs: [`مرحبًا ${esc(o.name)}،`, `${how} في إيزي فليت بتاريخ <b>${esc(formatWhen(o.when))}</b>، وتم تسجيل خروجك من الأجهزة الأخرى.`],
      button: { label: "تسجيل الدخول", url: `${b.appUrl}/login` },
      notes: ["إذا لم تقم بهذا التغيير فتواصل فورًا مع مسؤول النظام، واستخدم «نسيت كلمة المرور؟» في صفحة الدخول لتأمين حسابك."],
    }),
    text: textOf([`مرحبًا ${o.name}،`, `${how} في إيزي فليت بتاريخ ${formatWhen(o.when)}، وتم تسجيل خروجك من الأجهزة الأخرى.`, "إذا لم تقم بهذا التغيير فتواصل فورًا مع مسؤول النظام.", `${b.appUrl}/login`, supportLine(b)]),
  };
}

export function loginAlertEmail(b: Brand, o: { name: string; when: Date; ip: string | null; device: string | null }): Rendered {
  const subject = "تسجيل دخول جديد إلى حسابك - Easy Fleet";
  const details = [`الوقت: ${formatWhen(o.when)}`, o.ip ? `عنوان IP: ${o.ip}` : null, o.device ? `الجهاز/المتصفح: ${o.device}` : null].filter(Boolean) as string[];
  return {
    subject,
    html: layout(b, {
      preheader: "تم تسجيل الدخول إلى حسابك من جهاز جديد",
      heading: "تسجيل دخول من جهاز جديد",
      paragraphs: [`مرحبًا ${esc(o.name)}،`, "تم تسجيل الدخول إلى حسابك في إيزي فليت من جهاز أو موقع لم يُستخدم مؤخرًا:", `<span style="display:block;padding:12px 14px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;line-height:2">${details.map(esc).join("<br>")}</span>`],
      notes: ["إذا كان هذا أنت فلا داعي لأي إجراء.", "إذا لم تكن أنت فغيّر كلمة المرور فورًا من «نسيت كلمة المرور؟» وتواصل مع مسؤول النظام."],
    }),
    text: textOf([`مرحبًا ${o.name}،`, "تم تسجيل الدخول إلى حسابك في إيزي فليت من جهاز أو موقع لم يُستخدم مؤخرًا:", details.join("\n"), "إذا لم تكن أنت فغيّر كلمة المرور فورًا وتواصل مع مسؤول النظام.", supportLine(b)]),
  };
}

export function welcomeEmail(b: Brand, o: { name: string; email: string }): Rendered {
  const subject = "مرحبًا بك في Easy Fleet";
  return {
    subject,
    html: layout(b, {
      preheader: "تم إنشاء حسابك في إيزي فليت",
      heading: "مرحبًا بك في إيزي فليت",
      paragraphs: [`مرحبًا ${esc(o.name)}،`, `أنشأ لك مسؤول النظام حسابًا في إيزي فليت لإدارة الأسطول. اسم الدخول هو بريدك: <span dir="ltr">${esc(o.email)}</span>.`, "سيزوّدك المسؤول بكلمة مرور مؤقتة تُطلب منك تغييرها عند أول دخول، أو اختر كلمة مرور بنفسك من «نسيت كلمة المرور؟» في صفحة الدخول."],
      button: { label: "الدخول إلى إيزي فليت", url: `${b.appUrl}/login` },
      notes: ["لن نرسل كلمة المرور بالبريد أبدًا."],
    }),
    text: textOf([`مرحبًا ${o.name}،`, `أنشأ لك مسؤول النظام حسابًا في إيزي فليت. اسم الدخول: ${o.email}`, "سيزوّدك المسؤول بكلمة مرور مؤقتة، أو اختر كلمة مرور من «نسيت كلمة المرور؟» في صفحة الدخول.", `${b.appUrl}/login`, supportLine(b)]),
  };
}

/** Generic fleet notification (expiry, maintenance due, accident, approvals, system alerts). */
export function notificationEmail(b: Brand, o: { title: string; body?: string | null; link?: string | null; label: string; tone?: "info" | "warning" }): Rendered {
  const url = o.link ? `${b.appUrl}${o.link}` : `${b.appUrl}/notifications`;
  return {
    subject: `${o.title} - Easy Fleet`,
    html: layout(b, {
      preheader: o.title,
      heading: o.title,
      paragraphs: [o.label ? `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${o.tone === "warning" ? "#fef3c7;color:#92400e" : "#dbeafe;color:#1e40af"};font-size:12px;font-weight:700">${esc(o.label)}</span>` : "", ...(o.body ? [esc(o.body)] : [])].filter(Boolean),
      button: { label: "عرض في النظام", url },
      footerNote: "تصلك هذه الرسالة حسب إعدادات الإشعارات في حسابك؛ يمكنك تغييرها من صفحة «الإشعارات» في النظام.",
    }),
    text: textOf([o.title, o.body, url, supportLine(b), "يمكنك تغيير إعدادات إشعارات البريد من صفحة الإشعارات في النظام."]),
  };
}

export function testEmail(b: Brand, o: { by: string }): Rendered {
  return {
    subject: "رسالة اختبار - Easy Fleet",
    html: layout(b, { preheader: "إعدادات البريد تعمل", heading: "رسالة اختبار", paragraphs: ["هذه رسالة اختبار من إيزي فليت.", `أرسلها ${esc(o.by)} للتأكد من أن إعدادات البريد الإلكتروني تعمل بشكل صحيح.`] }),
    text: textOf(["هذه رسالة اختبار من إيزي فليت.", `أرسلها ${o.by} للتأكد من أن إعدادات البريد الإلكتروني تعمل بشكل صحيح.`]),
  };
}
