import { useEffect, useState } from "react";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import { VEHICLE_STATUS } from "../../lib/labels";
import type { Project, Vehicle } from "../../lib/types";

const MANUAL = ["AVAILABLE", "OUT_OF_SERVICE", "SOLD"];
const empty = {
  plateNumber: "", vehicleNumber: "", make: "", model: "", year: "", color: "", vin: "", currentOdometer: "",
  status: "AVAILABLE", projectId: "", purchaseDate: "", purchasePrice: "", warrantyStart: "", warrantyEnd: "", notes: "",
};

type Props = { open: boolean; onClose: () => void; onSaved: (v: Vehicle) => void; vehicle?: Vehicle | null; limited?: boolean };

/** `limited` = the user may only edit odometer and notes (ASSIGNED scope). */
export function VehicleFormModal({ open, onClose, onSaved, vehicle, limited = false }: Props) {
  const { can } = useAuth();
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
      vehicle
        ? Object.fromEntries(Object.keys(empty).map((k) => [k, (vehicle as unknown as Record<string, unknown>)[k] == null ? "" : String((vehicle as unknown as Record<string, unknown>)[k])])) as typeof empty
        : empty,
    );
    if (!limited && can("projects.read")) {
      api<Paged<Project>>("/projects", { query: { pageSize: 100 } })
        .then((r) => setProjects(r.data))
        .catch(() => setProjects([]));
    }
  }, [open, vehicle, limited, can]);

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const isWorkflowStatus = vehicle && !MANUAL.includes(vehicle.status);

  const save = async () => {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const c = clean(v);
      let body: Record<string, unknown>;
      if (limited) {
        body = { currentOdometer: c.currentOdometer === null ? undefined : Number(c.currentOdometer), notes: c.notes };
      } else {
        body = {
          ...c,
          year: c.year === null ? null : Number(c.year),
          currentOdometer: c.currentOdometer === null ? undefined : Number(c.currentOdometer),
          status: isWorkflowStatus ? undefined : c.status,
        };
        if (!vehicle && body.projectId === null) delete body.projectId;
      }
      const res = vehicle
        ? await api<{ data: Vehicle }>(`/vehicles/${vehicle.id}`, { method: "PATCH", body })
        : await api<{ data: Vehicle }>("/vehicles", { method: "POST", body });
      onSaved(res.data);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>إلغاء</Button>
      <Button onClick={save} loading={busy}>حفظ</Button>
    </>
  );

  if (limited) {
    return (
      <Modal open={open} onClose={onClose} title="تحديث العداد والملاحظات" footer={footer}>
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="قراءة العداد (كم)" error={errors.currentOdometer} htmlFor="v-odo">
            <Input id="v-odo" inputMode="numeric" dir="ltr" value={v.currentOdometer} onChange={set("currentOdometer")} />
          </Field>
          <Field label="ملاحظات" error={errors.notes} htmlFor="v-notes">
            <Textarea id="v-notes" value={v.notes} onChange={set("notes")} />
          </Field>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={vehicle ? "تعديل بيانات المركبة" : "إضافة مركبة"} size="lg" footer={footer}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="رقم اللوحة" required error={errors.plateNumber} htmlFor="v-plate">
            <Input id="v-plate" value={v.plateNumber} onChange={set("plateNumber")} />
          </Field>
          <Field label="رقم المركبة الداخلي" error={errors.vehicleNumber} htmlFor="v-num">
            <Input id="v-num" value={v.vehicleNumber} onChange={set("vehicleNumber")} />
          </Field>
          <Field label="رقم الهيكل (VIN)" error={errors.vin} htmlFor="v-vin">
            <Input id="v-vin" dir="ltr" maxLength={17} value={v.vin} onChange={set("vin")} />
          </Field>
          <Field label="الشركة المصنعة" required error={errors.make} htmlFor="v-make">
            <Input id="v-make" value={v.make} onChange={set("make")} />
          </Field>
          <Field label="الطراز" required error={errors.model} htmlFor="v-model">
            <Input id="v-model" value={v.model} onChange={set("model")} />
          </Field>
          <Field label="سنة الصنع" error={errors.year} htmlFor="v-year">
            <Input id="v-year" inputMode="numeric" dir="ltr" value={v.year} onChange={set("year")} />
          </Field>
          <Field label="اللون" error={errors.color} htmlFor="v-color">
            <Input id="v-color" value={v.color} onChange={set("color")} />
          </Field>
          <Field label="قراءة العداد (كم)" error={errors.currentOdometer} htmlFor="v-odo">
            <Input id="v-odo" inputMode="numeric" dir="ltr" value={v.currentOdometer} onChange={set("currentOdometer")} />
          </Field>
          <Field label="الحالة" error={errors.status} htmlFor="v-status" hint={isWorkflowStatus ? "هذه الحالة تُدار تلقائيًا من سير العمل" : undefined}>
            <Select id="v-status" value={v.status} onChange={set("status")} disabled={!!isWorkflowStatus}>
              {(isWorkflowStatus ? [vehicle!.status] : MANUAL).map((s) => (
                <option key={s} value={s}>{VEHICLE_STATUS[s]?.label ?? s}</option>
              ))}
            </Select>
          </Field>
          <Field label="المشروع" error={errors.projectId} htmlFor="v-project" hint={!can("vehicles.create", "ALL") ? "يمكنك الاختيار من مشاريعك فقط" : undefined}>
            <Select id="v-project" value={v.projectId} onChange={set("projectId")}>
              <option value="">— غير مخصصة لمشروع —</option>
              {vehicle?.projectId && !projects.some((p) => p.id === vehicle.projectId) && <option value={vehicle.projectId}>{vehicle.projectName}</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="تاريخ الشراء" error={errors.purchaseDate} htmlFor="v-pdate">
            <Input id="v-pdate" type="date" value={v.purchaseDate} onChange={set("purchaseDate")} />
          </Field>
          <Field label="سعر الشراء (ريال)" error={errors.purchasePrice} htmlFor="v-price">
            <Input id="v-price" inputMode="decimal" dir="ltr" value={v.purchasePrice} onChange={set("purchasePrice")} />
          </Field>
          <Field label="بداية الضمان" error={errors.warrantyStart} htmlFor="v-ws">
            <Input id="v-ws" type="date" value={v.warrantyStart} onChange={set("warrantyStart")} />
          </Field>
          <Field label="نهاية الضمان" error={errors.warrantyEnd} htmlFor="v-we">
            <Input id="v-we" type="date" value={v.warrantyEnd} onChange={set("warrantyEnd")} />
          </Field>
        </div>
        <Field label="ملاحظات" error={errors.notes} htmlFor="v-notes">
          <Textarea id="v-notes" value={v.notes} onChange={set("notes")} />
        </Field>
      </div>
    </Modal>
  );
}
