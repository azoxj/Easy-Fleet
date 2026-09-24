import { useEffect, useState } from "react";
import { useToast } from "../../components/feedback";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { api, type Paged } from "../../lib/api";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import { MAINTENANCE_PRIORITY, validateCreate } from "../../lib/maintenance";
import type { Vehicle } from "../../lib/types";

/**
 * The project is NOT chosen here: the server derives it from the vehicle.
 * Only vehicles visible to the user are offered.
 */
export function CreateMaintenanceModal({ open, onClose, onCreated, vehicleId }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; vehicleId?: string }) {
  const toast = useToast();
  const [v, setV] = useState({ vehicleId: vehicleId ?? "", issue: "", description: "", priority: "MEDIUM", odometer: "" });
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setV({ vehicleId: vehicleId ?? "", issue: "", description: "", priority: "MEDIUM", odometer: "" });
    setErrors({});
    setError(null);
    if (!vehicleId) {
      api<Paged<Vehicle>>("/vehicles", { query: { pageSize: 100 } })
        .then((r) => setVehicles(r.data.filter((x) => x.status !== "SOLD")))
        .catch(() => setVehicles([]));
    }
  }, [open, vehicleId]);

  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    const e = validateCreate(v);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const c = clean(v);
      const body: Record<string, unknown> = { vehicleId: c.vehicleId, issue: c.issue, description: c.description, priority: c.priority };
      if (c.odometer !== null) body.odometer = Number(c.odometer);
      const res = await api<{ data: { id: string } }>("/maintenance", { method: "POST", body });
      toast.success("تم إنشاء طلب الصيانة");
      onCreated(res.data.id);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="طلب صيانة جديد" footer={<><Button variant="secondary" onClick={onClose}>إلغاء</Button><Button onClick={save} loading={busy}>إنشاء الطلب</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {!vehicleId && (
          <Field label="المركبة" required error={errors.vehicleId} htmlFor="m-vehicle" hint="المشروع يُحدد تلقائيًا من المركبة">
            <Select id="m-vehicle" value={v.vehicleId} onChange={set("vehicleId")}>
              <option value="">اختر مركبة...</option>
              {vehicles.map((x) => <option key={x.id} value={x.id}>{x.plateNumber} — {x.make} {x.model}{x.projectName ? ` (${x.projectName})` : ""}</option>)}
            </Select>
          </Field>
        )}
        <Field label="العطل" required error={errors.issue} htmlFor="m-issue"><Input id="m-issue" value={v.issue} onChange={set("issue")} maxLength={200} /></Field>
        <Field label="التفاصيل" error={errors.description} htmlFor="m-desc"><Textarea id="m-desc" value={v.description} onChange={set("description")} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="الأولوية" required error={errors.priority} htmlFor="m-priority">
            <Select id="m-priority" value={v.priority} onChange={set("priority")}>
              {Object.entries(MAINTENANCE_PRIORITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
            </Select>
          </Field>
          <Field label="قراءة العداد (كم)" error={errors.odometer} htmlFor="m-odo" hint="اتركه فارغًا لاستخدام عداد المركبة">
            <Input id="m-odo" dir="ltr" inputMode="numeric" value={v.odometer} onChange={set("odometer")} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
