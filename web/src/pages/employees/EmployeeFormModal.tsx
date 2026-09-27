import { useEffect, useState } from "react";
import { useToast } from "../../components/feedback";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import type { EmployeeDetail, Project } from "../../lib/types";
import { t } from "../../i18n";

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
    if (!v.employeeNumber.trim()) e.employeeNumber = t("common.required");
    if (v.fullName.trim().length < 2) e.fullName = t("employeeForm.nameIsRequired");
    if (v.nationalIdOrIqama && !/^\d{10}$/.test(v.nationalIdOrIqama.trim())) e.nationalIdOrIqama = t("employeeForm.10Digits");
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = t("employeeForm.invalidEmail");
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
      toast.success(employee ? t("employeeForm.changesSaved") : t("employeeForm.employeeAdded"));
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
    <Modal open={open} onClose={onClose} size="lg" title={employee ? t("employeeForm.editEmployeeDetails") : t("common.addEmployee")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("common.employeeNumber")} required error={errors.employeeNumber} htmlFor="e-num"><Input id="e-num" dir="ltr" value={v.employeeNumber} onChange={set("employeeNumber")} /></Field>
          <Field label={t("employeeForm.fullName")} required error={errors.fullName} htmlFor="e-name"><Input id="e-name" value={v.fullName} onChange={set("fullName")} /></Field>
          <Field label={t("common.nationalIdIqamaNumber")} error={errors.nationalIdOrIqama} htmlFor="e-nid" hint={employee?.nationalIdMasked ? t("employeeForm.hiddenLeaveEmptyToKeep") : t("employeeForm.sensitiveDataNotShownIn")}>
            <Input id="e-nid" dir="ltr" inputMode="numeric" maxLength={10} value={v.nationalIdOrIqama} onChange={set("nationalIdOrIqama")} autoComplete="off" />
          </Field>
          <Field label={t("common.mobile")} error={errors.phone} htmlFor="e-phone"><Input id="e-phone" dir="ltr" inputMode="tel" value={v.phone} onChange={set("phone")} /></Field>
          <Field label={t("common.email")} error={errors.email} htmlFor="e-email"><Input id="e-email" dir="ltr" type="email" value={v.email} onChange={set("email")} /></Field>
          <Field label={t("common.jobTitle")} error={errors.jobTitle} htmlFor="e-job"><Input id="e-job" value={v.jobTitle} onChange={set("jobTitle")} /></Field>
          <Field label={t("common.project")} error={errors.projectId} htmlFor="e-project" hint={!can("employees.create", "ALL") ? t("employeeForm.fromYourProjectsOnly") : undefined}>
            <Select id="e-project" value={v.projectId} onChange={set("projectId")}>
              <option value="">{t("employeeForm.noProject")}</option>
              {employee?.projectId && !projects.some((p) => p.id === employee.projectId) && <option value={employee.projectId}>{employee.projectName}</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label={t("common.status")} error={errors.status} htmlFor="e-status">
            <Select id="e-status" value={v.status} onChange={set("status")}>
              <option value="ACTIVE">{t("common.active")}</option>
              <option value="INACTIVE">{t("common.inactive")}</option>
              <option value="SUSPENDED">{t("common.suspended")}</option>
            </Select>
          </Field>
          <Field label={t("common.startDate")} error={errors.hireDate} htmlFor="e-hire"><Input id="e-hire" type="date" value={v.hireDate} onChange={set("hireDate")} /></Field>
        </div>
        <Field label={t("common.notes")} error={errors.notes} htmlFor="e-notes"><Textarea id="e-notes" value={v.notes} onChange={set("notes")} /></Field>
      </div>
    </Modal>
  );
}
