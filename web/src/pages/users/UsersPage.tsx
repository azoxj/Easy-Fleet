import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Table, Td } from "../../components/ui";
import { useApi } from "../../hooks/useApi";
import { api, type Paged } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { clean, errorMessage, fieldErrors } from "../../lib/forms";
import { USER_STATUS } from "../../lib/labels";
import type { UserRow } from "../../lib/types";
import { t } from "../../i18n";

type Role = { key: string; nameAr: string; description: string | null };

function RolePicker({ roles, value, onChange }: { roles: Role[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {roles.map((r) => (
        <label key={r.key} className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/40">
          <input
            type="checkbox"
            className="mt-0.5 accent-brand-700"
            checked={value.includes(r.key)}
            onChange={(e) => onChange(e.target.checked ? [...value, r.key] : value.filter((k) => k !== r.key))}
          />
          <span>
            <span className="block text-sm font-medium text-slate-800">{r.nameAr}</span>
            <span className="block text-xs text-slate-500">{r.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Shows a one-time secret with a copy button; it is never retrievable again. */
function SecretNotice({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  return (
    <Modal open={!!secret} onClose={onClose} title={t("users.temporaryPassword")} footer={<Button onClick={onClose}>{t("common.done")}</Button>}>
      <div className="space-y-4">
        <Alert tone="amber">{t("users.copyThePasswordNowAnd")}</Alert>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-sm ltr select-all">{secret}</code>
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(secret ?? "")}>{t("users.copy")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function UserModal({ open, onClose, user, roles, onSaved, onSecret }: { open: boolean; onClose: () => void; user: UserRow | null; roles: Role[]; onSaved: () => void; onSecret: (s: string) => void }) {
  const { me } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const self = user?.id === me?.id;

  useEffect(() => {
    if (!open) return;
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
    setPhone(user?.phone ?? "");
    setRoleKeys(user?.roles.map((r) => r.key) ?? []);
    setErrors({});
    setError(null);
  }, [open, user]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      if (user) {
        await api(`/users/${user.id}`, { method: "PATCH", body: clean({ name, phone }) });
        const before = user.roles.map((r) => r.key).sort().join();
        if (!self && before !== [...roleKeys].sort().join()) await api(`/users/${user.id}/roles`, { method: "PUT", body: { roleKeys } });
      } else {
        const res = await api<{ temporaryPassword?: string }>("/users", { method: "POST", body: { ...clean({ name, email, phone }), roleKeys } });
        if (res.temporaryPassword) onSecret(res.temporaryPassword);
      }
      onSaved();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title={user ? t("users.editUser") : t("users.newUser")} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save} loading={busy} disabled={!name || !email || roleKeys.length === 0}>{t("common.save")}</Button></>}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t("common.name")} required error={errors.name} htmlFor="u-name"><Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("common.email")} required error={errors.email} htmlFor="u-email"><Input id="u-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!user} /></Field>
          <Field label={t("common.mobile")} error={errors.phone} htmlFor="u-phone"><Input id="u-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
        <Field label={t("users.roles")} required hint={self ? t("users.youCannotChangeYourOwn") : t("users.theRoleDefinesPermissionsThe")}>
          <fieldset disabled={self}><RolePicker roles={roles} value={roleKeys} onChange={setRoleKeys} /></fieldset>
        </Field>
        {!user && <Alert tone="blue">{t("users.aTemporaryPasswordWillBe")}</Alert>}
      </div>
    </Modal>
  );
}

export function UsersPage() {
  const { can, me } = useAuth();
  const manage = can("users.manage", "ALL");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<UserRow | null | undefined>(undefined);
  const [secret, setSecret] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, loading, error, reload } = useApi<Paged<UserRow>>("/users", { q, status, page, pageSize: 20 });
  const roles = useApi<{ data: Role[] }>(manage ? "/roles" : null);

  const toggleStatus = async (u: UserRow) => {
    const next = u.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    if (next === "DISABLED" && !window.confirm(t("users.disableTheyWillBeSigned", { name: u.name }))) return;
    setActionError(null);
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: { status: next } });
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const remove = async (u: UserRow) => {
    if (!window.confirm(t("users.deleteTheAccountIsPermanently", { name: u.name }))) return;
    setActionError(null);
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const resetPassword = async (u: UserRow) => {
    if (!window.confirm(t("users.resetThePasswordOf", { name: u.name }))) return;
    setActionError(null);
    try {
      const res = await api<{ data: { temporaryPassword: string } }>(`/users/${u.id}/reset-password`, { method: "POST" });
      setSecret(res.data.temporaryPassword);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader title={t("common.users")} subtitle={t("users.loginAccountsAndTheirRoles")} actions={manage && <Button icon="plus" onClick={() => setEditing(null)}>{t("users.newUser")}</Button>} />
      {actionError && <div className="mb-4"><Alert>{actionError}</Alert></div>}
      <Card>
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row">
          <Input placeholder={t("users.searchByNameOrEmail")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="sm:max-w-xs" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="sm:max-w-40">
            <option value="">{t("common.allStatuses")}</option>
            <option value="ACTIVE">{t("common.active")}</option>
            <option value="DISABLED">{t("users.disabled")}</option>
          </Select>
        </div>
        {loading ? <Loading /> : error ? <div className="p-4"><Alert>{error.message}</Alert></div> : !data?.data.length ? <EmptyState icon="users" title={t("users.noUsers")} /> : (
          <>
            <Table head={[t("common.user"), t("users.roles"), t("common.status"), t("users.lastSignIn"), ...(manage ? [""] : [])]}>
              {data.data.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <Td>
                    <p className="font-medium text-slate-900">{u.name} {u.id === me?.id && <span className="text-xs text-slate-400">{t("users.you")}</span>}</p>
                    <p className="text-xs text-slate-500 ltr">{u.email}</p>
                  </Td>
                  <Td><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.key} tone="blue">{r.nameAr}</Badge>)}</div></Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <StatusBadge map={USER_STATUS} value={u.status} />
                      {u.mustChangePassword && <Badge tone="amber">{t("users.mustChangePassword")}</Badge>}
                    </div>
                  </Td>
                  <Td>{formatDateTime(u.lastLoginAt)}</Td>
                  {manage && (
                    <Td>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" onClick={() => setEditing(u)}>{t("common.edit")}</Button>
                        {u.id !== me?.id && <Button variant="ghost" onClick={() => void resetPassword(u)}>{t("users.resetPassword")}</Button>}
                        {u.id !== me?.id && <Button variant="ghost" className={u.status === "ACTIVE" ? "text-red-600" : ""} onClick={() => void toggleStatus(u)}>{u.status === "ACTIVE" ? t("users.disable") : t("users.enable")}</Button>}
                        {u.id !== me?.id && (can("users.delete", "ALL") || can("users.manage", "ALL")) && <Button variant="ghost" className="text-red-700" onClick={() => void remove(u)}>{t("common.delete")}</Button>}
                      </div>
                    </Td>
                  )}
                </tr>
              ))}
            </Table>
            <Pagination {...data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      {manage && (
        <UserModal open={editing !== undefined} onClose={() => setEditing(undefined)} user={editing ?? null} roles={roles.data?.data ?? []} onSaved={reload} onSecret={setSecret} />
      )}
      <SecretNotice secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}
