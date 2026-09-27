import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { AlertList, ExpiryDate } from "../../components/common";
import { useToast } from "../../components/feedback";
import { Icon } from "../../components/icons";
import { StateBadge } from "../../components/StateBadge";
import { Alert, Button, Card, CardHeader, DescList, EmptyState, Field, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, cx } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { EXPIRY_STATUS, VEHICLE_STATUS } from "../../lib/labels";
import { agoLabel, speedLabel, toFleetVehicle, type LatestLocation } from "../../lib/fleetMap";
import { MAINTENANCE_STATUS, mrNumber } from "../../lib/maintenance";
import type { Compliance, DriverRow, MaintenanceRow, TimelineEvent, VehicleDetail } from "../../lib/types";
import { DocumentsTab } from "./tabs/DocumentsTab";
import { InsuranceTab } from "./tabs/InsuranceTab";
import { MaintenanceTab } from "./tabs/MaintenanceTab";
import { RegistrationTab } from "./tabs/RegistrationTab";
import { VehicleFormModal } from "./VehicleFormModal";
import { fileUrl } from "../../lib/api";
import { ExpensesList } from "../finance/ExpensesPage";
import { HandoversList } from "../handover/HandoverPages";
import { AccidentsList } from "../operations/AccidentsPages";
import { FuelList } from "../operations/FuelPage";
import { ViolationsList } from "../operations/ViolationsPages";
import { t } from "../../i18n";

// The GPS tab pulls in Leaflet — loaded only when opened.
const GpsTab = lazy(() => import("./tabs/GpsTab").then((m) => ({ default: m.GpsTab })));

const ALL_TABS = [
  { key: "overview", get label() { return t("vehicleDetail.overview"); } },
  { key: "documents", get label() { return t("common.documents"); }, anyOf: ["vehicle_documents.read", "registration.read"] },
  { key: "registration", get label() { return t("vehicleDetail.registration"); }, perm: "registration.read" },
  { key: "insurance", get label() { return t("vehicleDetail.insurance"); }, perm: "insurance.read" },
  { key: "maintenance", get label() { return t("common.maintenance"); }, perm: "maintenance.read" },
  { key: "fuel", get label() { return t("common.fuel"); }, perm: "fuel.read" },
  { key: "accidents", get label() { return t("common.accidents"); }, perm: "accidents.read" },
  { key: "violations", get label() { return t("common.violations"); }, perm: "violations.read" },
  { key: "handover", get label() { return t("vehicleDetail.handoverReturn"); }, perm: "handover.read" },
  { key: "gps", get label() { return t("vehicleDetail.gpsTrips"); }, perm: "gps.read" },
  { key: "expenses", get label() { return t("common.expenses"); }, perm: "finance.read" },
  { key: "timeline", get label() { return t("common.auditLog"); } },
];

type FuelStats = { totals: { count: number; liters: string; cost: string }; perVehicle: { kmPerLiter: string | null }[] };

/** One clickable summary tile of the vehicle profile strip. */
function ProfileTile({ label, icon, children, onClick, tone = "slate" }: { label: string; icon: string; children: ReactNode; onClick?: () => void; tone?: "slate" | "green" | "amber" | "red" | "blue" }) {
  const toneCls = { slate: "bg-slate-100 text-slate-600", green: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-700", red: "bg-red-50 text-red-700", blue: "bg-blue-50 text-blue-700" }[tone];
  const body = (
    <>
      <span className={cx("grid size-9 shrink-0 place-items-center rounded-lg", toneCls)}><Icon name={icon} className="size-5" /></span>
      <span className="min-w-0 flex-1 text-start">
        <span className="block text-xs text-slate-500">{label}</span>
        <span className="mt-0.5 block text-sm font-semibold break-words text-slate-900">{children}</span>
      </span>
      {onClick && <Icon name="chevron" className="size-4 shrink-0 rotate-180 text-slate-300" />}
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-brand-300 hover:shadow-sm active:scale-[0.99] active:bg-slate-50">{body}</button>
  ) : (
    <div className="flex min-h-16 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">{body}</div>
  );
}

const expiryTone = (s: string | null | undefined) => (s === "EXPIRED" ? "red" : s === "EXPIRING_SOON" ? "amber" : s === "ACTIVE" ? "green" : "slate");

/** Central vehicle profile: status, driver, project, live location, documents, maintenance and fuel at a glance. */
function ProfileStrip({ v, c, onTab }: { v: VehicleDetail; c: Compliance | undefined; onTab: (k: string) => void }) {
  const { can } = useAuth();
  const gps = useApi<{ data: LatestLocation[]; meta: { staleMinutes: number; serverTime: string } }>(can("gps.read") ? "/tracking/latest" : null, { vehicleId: v.id });
  const mr = useApi<Paged<MaintenanceRow>>(can("maintenance.read") ? "/maintenance" : null, { vehicleId: v.id, pageSize: 1 });
  const fuel = useApi<{ data: FuelStats }>(can("fuel.read") ? "/fuel/stats" : null, { vehicleId: v.id });
  const row = gps.data?.data[0];
  const loc = row && gps.data ? toFleetVehicle(row, Date.parse(gps.data.meta.serverTime), gps.data.meta.staleMinutes) : null;
  const lastMr = mr.data?.data[0];
  const f = fuel.data?.data;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <ProfileTile label={t("common.status")} icon="truck"><StatusBadge map={VEHICLE_STATUS} value={v.status} /></ProfileTile>
      <ProfileTile label={t("vehicleDetail.currentDriver")} icon="user" tone={v.currentDriver ? "blue" : "slate"}>
        {v.currentDriver ? <Link to={`/drivers/${v.currentDriver.id}`} className="text-brand-700 hover:underline">{v.currentDriver.fullName}</Link> : t("common.noDriver")}
      </ProfileTile>
      <ProfileTile label={t("common.project")} icon="folder">
        {v.projectId ? <Link to={`/projects/${v.projectId}`} className="text-brand-700 hover:underline">{v.projectName}</Link> : t("common.unassigned2")}
      </ProfileTile>
      {can("gps.read") && (
        <ProfileTile label={t("common.currentLocation")} icon="pin" tone={loc ? (loc.state === "MOVING" ? "green" : loc.state === "ALERT" ? "red" : loc.state === "STOPPED" ? "amber" : "slate") : "slate"} onClick={() => onTab("gps")}>
          {gps.loading ? "…" : loc ? <span className="flex flex-wrap items-center gap-1.5"><StateBadge state={loc.state} /> <span className="text-xs font-normal text-slate-500">{speedLabel(loc.speedKmh)} · {agoLabel(loc.ageSeconds)}</span></span> : t("vehicleDetail.noRecordedLocation")}
        </ProfileTile>
      )}
      {c?.registration !== undefined && (
        <ProfileTile label={t("vehicleDetail.registration")} icon="file" tone={expiryTone(c.registration?.status)} onClick={() => onTab("registration")}>
          {c.registration ? <span>{EXPIRY_STATUS[c.registration.status ?? ""]?.label ?? "—"} <span className="text-xs font-normal text-slate-500">· {formatDate(c.registration.expiryDate)}</span></span> : t("common.none")}
        </ProfileTile>
      )}
      {can("insurance.read") && (
        <ProfileTile label={t("vehicleDetail.insurance")} icon="shield" tone={expiryTone(c?.insurance?.status)} onClick={() => onTab("insurance")}>
          {c?.insurance ? <span>{EXPIRY_STATUS[c.insurance.status ?? ""]?.label ?? "—"} <span className="text-xs font-normal text-slate-500">· {formatDate(c.insurance.expiryDate)}</span></span> : t("vehicleDetail.noPolicy")}
        </ProfileTile>
      )}
      {can("maintenance.read") && (
        <ProfileTile label={t("common.lastMaintenance")} icon="wrench" tone={lastMr && !["CLOSED", "REJECTED"].includes(lastMr.status) ? "amber" : "slate"} onClick={() => onTab("maintenance")}>
          {mr.loading ? "…" : lastMr ? <span className="flex flex-wrap items-center gap-1.5"><span className="ltr">{mrNumber(lastMr.number)}</span><StatusBadge map={MAINTENANCE_STATUS} value={lastMr.status} /></span> : t("vehicleDetail.noRequests")}
        </ProfileTile>
      )}
      {can("fuel.read") && (
        <ProfileTile label={t("common.fuel")} icon="fuel" onClick={() => onTab("fuel")}>
          {fuel.loading ? "…" : f && f.totals.count > 0 ? <span>{formatMoney(f.totals.cost)} <span className="text-xs font-normal text-slate-500">{t("vehicleDetail.l", { liters: formatNumber(f.totals.liters), value: f.perVehicle[0]?.kmPerLiter ? t("vehicleDetail.kmL", { kmPerLiter: f.perVehicle[0].kmPerLiter }) : "" })}</span></span> : t("common.noFillUps")}
        </ProfileTile>
      )}
    </div>
  );
}

function Timeline({ id }: { id: string }) {
  const { data, loading, error } = useApi<{ data: TimelineEvent[] }>(`/vehicles/${id}/timeline`);
  if (loading) return <Loading />;
  if (error) return <Alert>{error.message}</Alert>;
  if (!data?.data.length) return <EmptyState icon="clock" title={t("vehicleDetail.noRecordedEvents")} />;
  return (
    <ol className="relative ms-3 border-s border-slate-200">
      {data.data.map((e) => (
        <li key={e.id} className="ms-6 pb-6">
          <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-brand-600" />
          <p className="text-sm font-medium break-words text-slate-800">{e.description}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            <span className="rounded bg-slate-100 px-1.5 py-0.5">{e.entityLabel}</span> · {e.actor} · {formatDateTime(e.timestamp)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function ChangeDriverModal({ vehicle, onClose, onSaved }: { vehicle: VehicleDetail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const drivers = useApi<Paged<DriverRow>>("/drivers", { projectId: vehicle.projectId ?? undefined, status: "ACTIVE", pageSize: 100 });
  const [driverId, setDriverId] = useState(vehicle.currentDriver?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = (drivers.data?.data ?? []).filter((d) => d.projectId === vehicle.projectId && (!d.currentVehicleId || d.currentVehicleId === vehicle.id));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/vehicles/${vehicle.id}/driver`, { method: "PUT", body: { driverId: driverId || null } });
      toast.success(driverId ? t("vehicleDetail.driverAssigned") : t("vehicleDetail.driverUnassigned"));
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("vehicleDetail.vehicleSCurrentDriver")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy} disabled={driverId === (vehicle.currentDriver?.id ?? "")}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Alert tone="blue">{t("vehicleDetail.onlyActiveDriversWithValid")}</Alert>
        <Field label={t("common.driver")} htmlFor="cd-driver">
          <Select id="cd-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">{t("vehicleDetail.noDriver")}</option>
            {options.map((d) => <option key={d.id} value={d.id}>{d.fullName}{d.licenseStatus === "EXPIRING_SOON" ? t("vehicleDetail.licenseExpiringSoon") : ""}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function ArchiveModal({ vehicle, onClose, onDone }: { vehicle: VehicleDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/vehicles/${vehicle.id}/archive`, { method: "POST", body: { reason } });
      toast.success(t("vehicleDetail.vehicleArchived"));
      onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("vehicleDetail.archiveVehicle", { plateNumber: vehicle.plateNumber })} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant="danger" onClick={submit} loading={busy}>{t("common.archive")}</Button></>}>
      <div className="space-y-4">
        <Alert tone="amber">{t("vehicleDetail.anArchivedVehicleBecomesRead")}</Alert>
        <Field label={t("vehicleDetail.archiveReasonOptional")} htmlFor="ar-reason"><Textarea id="ar-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function Overview({ v, onChanged, onTab }: { v: VehicleDetail; onChanged: () => void; onTab: (k: string) => void }) {
  const compliance = useApi<{ data: Compliance }>(`/vehicles/${v.id}/compliance`);
  const [changing, setChanging] = useState(false);
  const c = compliance.data?.data;
  return (
    <div className="space-y-6">
    <ProfileStrip v={v} c={c} onTab={onTab} />
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        {c && c.alerts.length > 0 && (
          <Card>
            <CardHeader title={t("common.alerts2")} />
            <div className="p-5"><AlertList alerts={c.alerts} /></div>
          </Card>
        )}
        <Card>
          <CardHeader title={t("vehicleDetail.vehicleDetails")} />
          <div className="p-5">
            <DescList
              items={[
                { label: t("common.plateNumber"), value: <span className="ltr">{v.plateNumber}</span> },
                { label: t("vehicleDetail.plateArabicEnglish"), value: [v.plateArabic, v.plateEnglish ? <span key="en" className="ltr">{v.plateEnglish}</span> : null].filter(Boolean).length ? <span className="flex gap-2">{v.plateArabic}{v.plateEnglish && <span className="ltr text-slate-500">{v.plateEnglish}</span>}</span> : "—" },
                { label: t("vehicleDetail.serialNumber"), value: v.serialNumber ? <span className="ltr">{v.serialNumber}</span> : "—" },
                { label: t("common.internalVehicleNumber"), value: v.vehicleNumber ?? "—" },
                { label: t("common.chassisNumberVin"), value: v.vin ? <span className="ltr break-all">{v.vin}</span> : "—" },
                { label: t("vehicleDetail.makeModel"), value: `${v.make} ${v.model}` },
                { label: t("common.year"), value: v.year ?? "—" },
                { label: t("common.color"), value: v.color ?? "—" },
                { label: t("common.odometerReading"), value: t("common.km", { currentOdometer: formatNumber(v.currentOdometer) }) },
                { label: t("common.status"), value: <StatusBadge map={VEHICLE_STATUS} value={v.status} /> },
                { label: t("common.project"), value: v.projectId ? <Link className="text-brand-700 hover:underline" to={`/projects/${v.projectId}`}>{v.projectName}</Link> : t("common.unassigned2") },
              ]}
            />
            {v.notes && <p className="mt-5 rounded-lg bg-slate-50 p-4 text-sm whitespace-pre-line text-slate-700">{v.notes}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("vehicleDetail.registrationInsurance")} />
          {compliance.loading ? <Loading /> : (
            <div className="p-5">
              <DescList
                items={[
                  ...(c?.registration !== undefined
                    ? [
                        { label: t("common.registrationNumber"), value: c?.registration?.documentNumber ? <span className="ltr">{c.registration.documentNumber}</span> : "—" },
                        { label: t("vehicleDetail.registrationExpiry"), value: c?.registration ? <ExpiryDate date={c.registration.expiryDate} status={c.registration.status} daysLeft={c.registration.daysLeft} /> : t("common.none") },
                      ]
                    : []),
                  ...(c?.insurance
                    ? [
                        { label: t("common.insuranceCompany"), value: c.insurance.provider },
                        { label: t("vehicleDetail.insuranceExpiry"), value: <ExpiryDate date={c.insurance.expiryDate} status={c.insurance.status} daysLeft={c.insurance.daysLeft} /> },
                      ]
                    : [{ label: t("vehicleDetail.insurance"), value: c ? t("vehicleDetail.noPolicyOrNotWithin") : "—" }]),
                ]}
              />
            </div>
          )}
        </Card>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("vehicleDetail.currentDriver")} action={v.capabilities.changeDriver && <Button variant="secondary" onClick={() => setChanging(true)}>{v.currentDriver ? t("vehicleDetail.change") : t("vehicleDetail.assignDriver")}</Button>} />
          <div className="p-5 text-sm">
            {v.currentDriver ? (
              <div className="space-y-2">
                <p className="font-medium text-slate-900">{v.currentDriver.fullName}</p>
                {c?.driverLicense && <p className="text-slate-600">{t("vehicleDetail.license")} <ExpiryDate date={c.driverLicense.licenseExpiryDate} status={c.driverLicense.licenseStatus} /></p>}
                <Link to={`/drivers/${v.currentDriver.id}`} className="inline-flex items-center gap-1 text-brand-700 hover:underline">{t("common.driverProfile")} <Icon name="back" className="size-4" /></Link>
              </div>
            ) : (
              <p className="text-slate-500">{t("vehicleDetail.noDriverAssigned")}</p>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t("vehicleDetail.purchaseWarranty")} />
          <div className="p-5">
            <DescList
              items={[
                { label: t("common.purchaseDate"), value: formatDate(v.purchaseDate) },
                { label: t("vehicleDetail.purchasePrice"), value: formatMoney(v.purchasePrice) },
                { label: t("common.warrantyStart"), value: formatDate(v.warrantyStart) },
                { label: t("common.warrantyEnd"), value: formatDate(v.warrantyEnd) },
              ]}
            />
          </div>
        </Card>
      </div>
      {changing && <ChangeDriverModal vehicle={v} onClose={() => setChanging(false)} onSaved={() => { onChanged(); compliance.reload(); }} />}
    </div>
    </div>
  );
}

export function VehicleDetailPage() {
  const { id = "" } = useParams();
  const { me, can } = useAuth();
  const { data, loading, error, reload } = useApi<{ data: VehicleDetail }>(`/vehicles/${id}`);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "audit" ? "timeline" : (params.get("tab") ?? "overview");
  const setTab = (k: string) => {
    const next = new URLSearchParams(params);
    if (k === "overview") next.delete("tab");
    else next.set("tab", k);
    setParams(next, { replace: true });
  };
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [version, setVersion] = useState(0);
  const [qr, setQr] = useState(false);

  if (loading && !data) return <Loading />;
  if (error || !data) return <EmptyState icon="truck" title={error?.status === 404 ? t("vehicleDetail.vehicleNotFound") : t("vehicleDetail.couldNotLoadTheVehicle")} description={error?.message} action={<Link to="/vehicles" className="text-sm text-brand-700">{t("vehicleDetail.backToVehicles")}</Link>} />;
  const v = data.data;
  const limited = me?.permissions["vehicles.update"] === "ASSIGNED" || (me?.permissions["vehicles.update"] === "PROJECT" && !me.projectIds.includes(v.projectId ?? ""));
  const tabs = ALL_TABS.filter((item) => (item.perm ? can(item.perm) : item.anyOf ? item.anyOf.some((p) => can(p)) : true));
  const active = tabs.find((item) => item.key === tab) ?? tabs[0]!;
  const refresh = () => { reload(); setVersion((x) => x + 1); };

  return (
    <>
      <PageHeader
        back={<Link to="/vehicles" className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><Icon name="chevron" className="size-4" /> {t("common.vehicles")}</Link>}
        title={<span className="flex flex-wrap items-center gap-3"><span className="ltr">{v.plateNumber}</span> <StatusBadge map={VEHICLE_STATUS} value={v.status} /></span>}
        subtitle={`${v.make} ${v.model}${v.year ? ` — ${v.year}` : ""}`}
        actions={
          <>
            <Button variant="secondary" icon="qr" onClick={() => setQr(true)}>{t("vehicleDetail.qrCode")}</Button>
            {v.capabilities.update && <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>{limited ? t("vehicleDetail.updateOdometer") : t("common.edit")}</Button>}
            {v.capabilities.archive && <Button variant="danger" icon="archive" onClick={() => setArchiving(true)}>{t("common.archive")}</Button>}
          </>
        }
      />
      <Tabs tabs={tabs} active={active.key} onChange={setTab} />
      <div className="mt-5" key={version}>
        {active.key === "overview" && <Overview v={v} onChanged={refresh} onTab={setTab} />}
        {active.key === "gps" && <Suspense fallback={<Loading />}><GpsTab vehicleId={id} /></Suspense>}
        {active.key === "registration" && <RegistrationTab vehicleId={id} />}
        {active.key === "insurance" && <InsuranceTab vehicleId={id} />}
        {active.key === "documents" && <DocumentsTab vehicleId={id} />}
        {active.key === "maintenance" && <MaintenanceTab vehicleId={id} archived={v.status === "ARCHIVED"} />}
        {active.key === "timeline" && <Card className="p-5"><Timeline id={id} /></Card>}
        {active.key === "fuel" && <FuelList vehicleId={id} embedded />}
        {active.key === "accidents" && <AccidentsList vehicleId={id} embedded />}
        {active.key === "violations" && <ViolationsList vehicleId={id} embedded />}
        {active.key === "handover" && <HandoversList vehicleId={id} embedded />}
        {active.key === "expenses" && <ExpensesList vehicleId={id} projectId={v.projectId ?? undefined} embedded />}
      </div>
      <VehicleFormModal open={editing} onClose={() => setEditing(false)} vehicle={v} limited={limited} onSaved={refresh} />
      {archiving && <ArchiveModal vehicle={v} onClose={() => setArchiving(false)} onDone={refresh} />}
      <Modal open={qr} onClose={() => setQr(false)} title={t("vehicleDetail.qrCodeForVehicle", { plateNumber: v.plateNumber })} footer={<><a className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm ring-1 ring-slate-300" href={fileUrl(`/vehicles/${id}/qr?format=png`)} download={`qr-${v.plateNumber}.png`}>{t("vehicleDetail.downloadPng")}</a><Button icon="printer" onClick={() => window.print()}>{t("vehicleDetail.print")}</Button></>}>
        <div className="text-center">
          {qr && <img src={fileUrl(`/vehicles/${id}/qr`)} alt={t("vehicleDetail.qrCodeForVehicle", { plateNumber: v.plateNumber })} className="mx-auto size-64" />}
          <p className="mt-3 text-lg font-bold ltr">{v.plateNumber}</p>
          <p className="mt-1 text-xs text-slate-500">{t("vehicleDetail.scanningTheCodeOpensThe")}</p>
        </div>
      </Modal>
    </>
  );
}
