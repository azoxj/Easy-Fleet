import { useEffect, useState } from "react";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import { PROJECT_STATUS } from "../../lib/labels";
import type { Project } from "../../lib/types";

type Props = { open: boolean; onClose: () => void; onSaved: (p: Project) => void; project?: Project | null; sensitive: boolean };

const empty = { name: "", code: "", description: "", status: "PLANNED", startDate: "", endDate: "", budget: "", managerId: "" };

export function ProjectFormModal({ open, onClose, onSaved, project, sensitive }: Props) {
  const [v, setV] = useState(empty);
  const [managers, setManagers] = useState<{ id: string; name: string; roles: string[] }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setV(
      project
        ? {
            name: project.name,
            code: project.code,
            description: project.description ?? "",
            status: project.status,
            startDate: project.startDate ?? "",
            endDate: project.endDate ?? "",
            budget: project.budget ?? "",
            managerId: project.managerId ?? "",
          }
        : empty,
    );
    if (sensitive) {
      api<{ data: { id: string; name: string; roles: string[] }[] }>("/users/lookup/active")
        .then((r) => setManagers(r.data.filter((u) => u.roles.includes("PROJECT_MANAGER") || u.roles.includes("SUPER_ADMIN"))))
        .catch(() => setManagers([]));
    }
  }, [open, project, sensitive]);

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const c = clean(v);
      const body: Record<string, unknown> = { name: c.name, description: c.description, status: c.status, startDate: c.startDate, endDate: c.endDate };
      if (sensitive) Object.assign(body, { code: c.code, budget: c.budget, managerId: c.managerId });
      const res = project
        ? await api<{ data: Project }>(`/projects/${project.id}`, { method: "PATCH", body })
        : await api<{ data: Project }>("/projects", { method: "POST", body });
      onSaved(res.data);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={project ? "تعديل المشروع" : "مشروع جديد"}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>إلغاء</Button>
          <Button onClick={save} loading={busy}>حفظ</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="اسم المشروع" required error={errors.name} htmlFor="p-name">
            <Input id="p-name" value={v.name} onChange={set("name")} />
          </Field>
          <Field label="رمز المشروع" required error={errors.code} hint="أحرف إنجليزية وأرقام، مثل HOSP-01" htmlFor="p-code">
            <Input id="p-code" dir="ltr" value={v.code} onChange={set("code")} disabled={!sensitive} />
          </Field>
          <Field label="مدير التشغيل" error={errors.managerId} htmlFor="p-mgr">
            <Select id="p-mgr" value={v.managerId} onChange={set("managerId")} disabled={!sensitive}>
              <option value="">— بدون —</option>
              {!sensitive && project?.managerName && <option value={project.managerId ?? ""}>{project.managerName}</option>}
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="الحالة" error={errors.status} htmlFor="p-status">
            <Select id="p-status" value={v.status} onChange={set("status")}>
              {Object.entries(PROJECT_STATUS).map(([k, l]) => (
                <option key={k} value={k}>{l.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="تاريخ البداية" error={errors.startDate} htmlFor="p-start">
            <Input id="p-start" type="date" value={v.startDate} onChange={set("startDate")} />
          </Field>
          <Field label="تاريخ النهاية" error={errors.endDate} htmlFor="p-end">
            <Input id="p-end" type="date" value={v.endDate} onChange={set("endDate")} />
          </Field>
          <Field label="الميزانية (ريال)" error={errors.budget} htmlFor="p-budget">
            <Input id="p-budget" inputMode="decimal" dir="ltr" value={v.budget} onChange={set("budget")} disabled={!sensitive} />
          </Field>
        </div>
        <Field label="الوصف" error={errors.description} htmlFor="p-desc">
          <Textarea id="p-desc" value={v.description} onChange={set("description")} />
        </Field>
      </div>
    </Modal>
  );
}
