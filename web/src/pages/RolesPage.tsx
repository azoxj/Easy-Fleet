import { Alert, Card, CardHeader, Loading, PageHeader } from "../components/ui";
import { useApi } from "../hooks/useApi";
import { SCOPE_LABEL } from "../lib/labels";

type Role = { id: string; key: string; nameAr: string; description: string | null; isSystem: boolean; permissions: Record<string, string> };
type Permission = { key: string; module: string; descriptionAr: string };

const SCOPE_TONE: Record<string, string> = {
  ALL: "bg-emerald-100 text-emerald-800",
  PROJECT: "bg-blue-100 text-blue-800",
  ASSIGNED: "bg-amber-100 text-amber-800",
};

export function RolesPage() {
  const roles = useApi<{ data: Role[] }>("/roles");
  const perms = useApi<{ data: Permission[] }>("/roles/permissions");
  if (roles.loading || perms.loading) return <Loading />;
  if (roles.error || perms.error) return <Alert>{(roles.error ?? perms.error)!.message}</Alert>;
  const r = roles.data!.data;
  const p = perms.data!.data;

  return (
    <>
      <PageHeader title="الأدوار والصلاحيات" subtitle="مصفوفة الصلاحيات للأدوار المدمجة (للعرض فقط في هذه المرحلة)" />
      <div className="mb-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(SCOPE_LABEL).map(([k, l]) => (
          <span key={k} className={`rounded-full px-2.5 py-1 font-medium ${SCOPE_TONE[k]}`}>{l}</span>
        ))}
        <span className="text-slate-500">— الكل ⊇ المشاريع ⊇ المسند فقط. الإسناد لا يمنح صلاحية لا يملكها الدور.</span>
      </div>
      <Card>
        <CardHeader title="المصفوفة" />
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="sticky start-0 z-10 bg-slate-50 px-4 py-3 text-start text-xs font-semibold text-slate-500">الصلاحية</th>
                {r.map((role) => (
                  <th key={role.id} className="px-3 py-3 text-center text-xs font-semibold whitespace-nowrap text-slate-600">{role.nameAr}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.map((perm) => (
                <tr key={perm.key}>
                  <td className="sticky start-0 bg-white px-4 py-2.5">
                    <p className="font-medium text-slate-800">{perm.descriptionAr}</p>
                    <p className="text-[11px] text-slate-400 ltr">{perm.key}</p>
                  </td>
                  {r.map((role) => {
                    const s = role.permissions[perm.key];
                    return (
                      <td key={role.id} className="px-3 py-2.5 text-center">
                        {s ? <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${SCOPE_TONE[s]}`}>{SCOPE_LABEL[s]}</span> : <span className="text-slate-300">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
