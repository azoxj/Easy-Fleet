import { useEffect, useState } from "react";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "../../components/ui";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import { VEHICLE_STATUS } from "../../lib/labels";
import type { Project, Vehicle } from "../../lib/types";
import { t } from "../../i18n";

const MANUAL = ["AVAILABLE", "OUT_OF_SERVICE", "SOLD"];
const empty = {
  plateNumber: "", plateArabic: "", plateEnglish: "", serialNumber: "", vehicleNumber: "", make: "", model: "", year: "", color: "", vin: "", currentOdometer: "",
  status: "AVAILABLE", projectId: "", purchaseDate: "", purchasePrice: "", warrantyStart: "", warrantyEnd: "", notes: "",
  nextServiceDate: "", nextServiceOdometer: "", nextOilChangeDate: "", nextOilChangeOdometer: "",
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
          nextServiceOdometer: c.nextServiceOdometer === null ? null : Number(c.nextServiceOdometer),
          nextOilChangeOdometer: c.nextOilChangeOdometer === null ? null : Number(c.nextOilChangeOdometer),
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
      <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
      <Button onClick={save} loading={busy}>{t("common.save")}</Button>
    </>
  );

  if (limited) {
    return (
      <Modal open={open} onClose={onClose} title={t("vehicleForm.updateOdometerAndNotes")} footer={footer}>
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label={t("common.odometerReadingKm")} error={errors.currentOdometer} htmlFor="v-odo">
            <Input id="v-odo" inputMode="numeric" dir="ltr" value={v.currentOdometer} onChange={set("currentOdometer")} />
          </Field>
          <Field label={t("common.notes")} error={errors.notes} htmlFor="v-notes">
            <Textarea id="v-notes" value={v.notes} onChange={set("notes")} />
          </Field>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={vehicle ? t("vehicleForm.editVehicleDetails") : t("common.addVehicle")} size="lg" footer={footer}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t("common.plateNumber")} required error={errors.plateNumber} htmlFor="v-plate">
            <Input id="v-plate" value={v.plateNumber} onChange={set("plateNumber")} />
          </Field>
          <Field label={t("vehicleForm.plateInArabic")} error={errors.plateArabic} htmlFor="v-plate-ar" hint={t("vehicleForm.example1234")}>
            <Input id="v-plate-ar" value={v.plateArabic} onChange={set("plateArabic")} />
          </Field>
          <Field label={t("vehicleForm.plateInEnglish")} error={errors.plateEnglish} htmlFor="v-plate-en">
            <Input id="v-plate-en" dir="ltr" value={v.plateEnglish} onChange={set("plateEnglish")} />
          </Field>
          <Field label={t("vehicleForm.serialNumberRegistration")} error={errors.serialNumber} htmlFor="v-serial">
            <Input id="v-serial" dir="ltr" value={v.serialNumber} onChange={set("serialNumber")} />
          </Field>
          <Field label={t("common.internalVehicleNumber")} error={errors.vehicleNumber} htmlFor="v-num">
            <Input id="v-num" value={v.vehicleNumber} onChange={set("vehicleNumber")} />
          </Field>
          <Field label={t("common.chassisNumberVin")} error={errors.vin} htmlFor="v-vin">
            <Input id="v-vin" dir="ltr" maxLength={17} value={v.vin} onChange={set("vin")} />
          </Field>
          <Field label={t("vehicleForm.make")} required error={errors.make} htmlFor="v-make">
            <Input id="v-make" value={v.make} onChange={set("make")} />
          </Field>
          <Field label={t("common.model")} required error={errors.model} htmlFor="v-model">
            <Input id="v-model" value={v.model} onChange={set("model")} />
          </Field>
          <Field label={t("common.year")} error={errors.year} htmlFor="v-year">
            <Input id="v-year" inputMode="numeric" dir="ltr" value={v.year} onChange={set("year")} />
          </Field>
          <Field label={t("common.color")} error={errors.color} htmlFor="v-color">
            <Input id="v-color" value={v.color} onChange={set("color")} />
          </Field>
          <Field label={t("common.odometerReadingKm")} error={errors.currentOdometer} htmlFor="v-odo">
            <Input id="v-odo" inputMode="numeric" dir="ltr" value={v.currentOdometer} onChange={set("currentOdometer")} />
          </Field>
          <Field label={t("common.status")} error={errors.status} htmlFor="v-status" hint={isWorkflowStatus ? t("vehicleForm.thisStatusIsManagedAutomatically") : undefined}>
            <Select id="v-status" value={v.status} onChange={set("status")} disabled={!!isWorkflowStatus}>
              {(isWorkflowStatus ? [vehicle!.status] : MANUAL).map((s) => (
                <option key={s} value={s}>{VEHICLE_STATUS[s]?.label ?? s}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("common.project")} error={errors.projectId} htmlFor="v-project" hint={!can("vehicles.create", "ALL") ? t("vehicleForm.youCanOnlyChooseFrom") : undefined}>
            <Select id="v-project" value={v.projectId} onChange={set("projectId")}>
              <option value="">{t("vehicleForm.notAssignedToAProject")}</option>
              {vehicle?.projectId && !projects.some((p) => p.id === vehicle.projectId) && <option value={vehicle.projectId}>{vehicle.projectName}</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("common.purchaseDate")} error={errors.purchaseDate} htmlFor="v-pdate">
            <Input id="v-pdate" type="date" value={v.purchaseDate} onChange={set("purchaseDate")} />
          </Field>
          <Field label={t("vehicleForm.purchasePriceSar")} error={errors.purchasePrice} htmlFor="v-price">
            <Input id="v-price" inputMode="decimal" dir="ltr" value={v.purchasePrice} onChange={set("purchasePrice")} />
          </Field>
          <Field label={t("common.warrantyStart")} error={errors.warrantyStart} htmlFor="v-ws">
            <Input id="v-ws" type="date" value={v.warrantyStart} onChange={set("warrantyStart")} />
          </Field>
          <Field label={t("common.warrantyEnd")} error={errors.warrantyEnd} htmlFor="v-we">
            <Input id="v-we" type="date" value={v.warrantyEnd} onChange={set("warrantyEnd")} />
          </Field>
        </div>
        <fieldset className="rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-sm font-semibold text-slate-700">{t("serviceSchedule.title")}</legend>
          <p className="mb-3 text-xs text-slate-500">{t("serviceSchedule.hint")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("serviceSchedule.nextServiceDate")} error={errors.nextServiceDate} htmlFor="v-nsd">
              <Input id="v-nsd" type="date" value={v.nextServiceDate} onChange={set("nextServiceDate")} />
            </Field>
            <Field label={t("serviceSchedule.nextServiceOdometer")} error={errors.nextServiceOdometer} htmlFor="v-nso">
              <Input id="v-nso" inputMode="numeric" dir="ltr" value={v.nextServiceOdometer} onChange={set("nextServiceOdometer")} />
            </Field>
            <Field label={t("serviceSchedule.nextOilChangeDate")} error={errors.nextOilChangeDate} htmlFor="v-nod">
              <Input id="v-nod" type="date" value={v.nextOilChangeDate} onChange={set("nextOilChangeDate")} />
            </Field>
            <Field label={t("serviceSchedule.nextOilChangeOdometer")} error={errors.nextOilChangeOdometer} htmlFor="v-noo">
              <Input id="v-noo" inputMode="numeric" dir="ltr" value={v.nextOilChangeOdometer} onChange={set("nextOilChangeOdometer")} />
            </Field>
          </div>
        </fieldset>
        <Field label={t("common.notes")} error={errors.notes} htmlFor="v-notes">
          <Textarea id="v-notes" value={v.notes} onChange={set("notes")} />
        </Field>
      </div>
    </Modal>
  );
}
