import { useEffect, useState } from "react";
import { useToast } from "../../components/feedback";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import type { EmployeeDetail, Project } from "../../lib/types";

const empty = { employeeNumber: "", fullName: "", nationalIdOrIqama: "", phone: "", email: "", jobTitle: "", projectId: "", status: "ACTIVE", hireDate: "", notes: "" };

export function EmployeeFormModal({ open, onClose, employee, onSaved }: { open: boolean; onClose: () => void; employee?: EmployeeDetail | null; onSaved: (id: string) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [v, setV] = useState(empty);
  const [projects, setProjects] = useState<Project[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setV(
      employee
        ? {
            employeeNumber: employee.employeeNumber,
            fullName: employee.fullName,
            // A masked value is never sent back; the field stays empty unless the user types a new one.
            nationalIdOrIqama: employee.nationalIdMasked ? "" : (employee.nationalIdOrIqama ?? ""),
            phone: employee.phone ?? "",
            email: employee.email ?? "",
            jobTitle: employee.jobTitle ?? "",
            projectId: employee.projectId ?? "",
            status: employee.status,
            hireDate: employee.hireDate ?? "",
            notes: employee.notes ?? "",
          }
        : empty,
    );
    if (can("projects.read")) {
      api<Paged<Project>>("/projects", { query: { pageSize: 100 } })
        .then((r) => setProjects(r.data))
        .catch(() => setProjects([]));
    }
  }, [open, employee, can]);

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.employeeNumber.trim()) e.employeeNumber = "مطلوب";
    if (v.fullName.trim().length < 2) e.fullName = "الاسم مطلوب";
    if (v.nationalIdOrIqama && !/^\d{10}$/.test(v.nationalIdOrIqama.trim())) e.nationalIdOrIqama = "10 أرقام";
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = "بريد غير صالح";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      const c = clean(v);
      const body: Record<string, unknown> = { ...c };
      if (employee?.nationalIdMasked && !c.nationalIdOrIqama) delete body.nationalIdOrIqama;
      if (!employee && !c.projectId) delete body.projectId;
      const res = employee
        ? await api<{ data: { id: string } }>(`/employees/${employee.id}`, { method: "PATCH", body })
        : await api<{ data: { id: string } }>("/employees", { method: "POST", body });
      toast.success(employee ? "تم حفظ التعديلات" : "تمت إضافة الموظف");
      onSaved(res.data.id);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title={employee ? "تعديل بيانات الموظف" : "إضافة موظف"} footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} loading={busy}>حفظ</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="رقم الموظف" required error={errors.employeeNumber} htmlFor="e-num"><Input id="e-num" dir="ltr" value={v.employeeNumber} onChange={set("employeeNumber")} /></Field>
          <Field label="الاسم الكامل" required error={errors.fullName} htmlFor="e-name"><Input id="e-name" value={v.fullName} onChange={set("fullName")} /></Field>
          <Field label="رقم الهوية/الإقامة" error={errors.nationalIdOrIqama} htmlFor="e-nid" hint={employee?.nationalIdMasked ? "مخفي — اتركه فارغًا للإبقاء عليه" : "بيانات حساسة، لا تظهر في البحث"}>
            <Input id="e-nid" dir="ltr" inputMode="numeric" maxLength={10} value={v.nationalIdOrIqama} onChange={set("nationalIdOrIqama")} autoComplete="off" />
          </Field>
          <Field label="الجوال" error={errors.phone} htmlFor="e-phone"><Input id="e-phone" dir="ltr" inputMode="tel" value={v.phone} onChange={set("phone")} /></Field>
          <Field label="البريد الإلكتروني" error={errors.email} htmlFor="e-email"><Input id="e-email" dir="ltr" type="email" value={v.email} onChange={set("email")} /></Field>
          <Field label="المسمى الوظيفي" error={errors.jobTitle} htmlFor="e-job"><Input id="e-job" value={v.jobTitle} onChange={set("jobTitle")} /></Field>
          <Field label="المشروع" error={errors.projectId} htmlFor="e-project" hint={!can("employees.create", "ALL") ? "من مشاريعك فقط" : undefined}>
            <Select id="e-project" value={v.projectId} onChange={set("projectId")}>
              <option value="">— بدون مشروع —</option>
              {employee?.projectId && !projects.some((p) => p.id === employee.projectId) && <option value={employee.projectId}>{employee.projectName}</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="الحالة" error={errors.status} htmlFor="e-status">
            <Select id="e-status" value={v.status} onChange={set("status")}>
              <option value="ACTIVE">نشط</option>
              <option value="INACTIVE">غير نشط</option>
              <option value="SUSPENDED">موقوف</option>
            </Select>
          </Field>
          <Field label="تاريخ المباشرة" error={errors.hireDate} htmlFor="e-hire"><Input id="e-hire" type="date" value={v.hireDate} onChange={set("hireDate")} /></Field>
        </div>
        <Field label="ملاحظات" error={errors.notes} htmlFor="e-notes"><Textarea id="e-notes" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}
