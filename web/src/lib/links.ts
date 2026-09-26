/**
 * In-app links for records referenced by id (dashboard activity, audit rows…).
 * Returns null when the entity has no detail page (e.g. a login session).
 */
const ENTITY_PATH: Partial<Record<string, (id: string) => string>> = {
  vehicle: (id) => `/vehicles/${id}`,
  project: (id) => `/projects/${id}`,
  employee: (id) => `/employees/${id}`,
  driver: (id) => `/drivers/${id}`,
  maintenance_request: (id) => `/maintenance/${id}`,
  invoice: (id) => `/finance/invoices/${id}`,
  accident: (id) => `/accidents/${id}`,
  violation: (id) => `/violations/${id}`,
  handover_session: (id) => `/handovers/${id}`,
  trip: (id) => `/tracking/trips/${id}`,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function entityLink(entity: string, id: string | null | undefined): string | null {
  const f = ENTITY_PATH[entity];
  return f && id && UUID.test(id) ? f(id) : null;
}

/** "2026-05" → first and last day of that month (for chart drill-downs). */
export function monthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}` };
}

export function withRange(path: string, month: string): string {
  const r = monthRange(month);
  return r ? `${path}?from=${r.from}&to=${r.to}` : path;
}
