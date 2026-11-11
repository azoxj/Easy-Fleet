import type { Scope } from "../auth/permissions.js";

export type CatalogGrants = Record<string, Scope>;
export type RoleSnapshot = { key: string; grants: CatalogGrants };

export type RoleDiff = {
  role: string;
  /** Role exists in code but not in the database: bootstrap would create it. */
  newRole: boolean;
  added: { permission: string; scope: Scope }[];
  removed: { permission: string; scope: Scope }[];
  changed: { permission: string; from: Scope; to: Scope }[];
};

export type CatalogDiff = {
  permissionsToAdd: string[];
  permissionsToRemove: string[];
  roles: RoleDiff[];
  /** Roles in the database (system) that the code no longer defines: left alone by bootstrap. */
  unknownRoles: string[];
};

/**
 * Pure comparison between what the database holds and what `syncCatalog` would write.
 * Used by the read-only preview tool; it never touches the database itself.
 */
export function diffCatalog(db: { permissions: string[]; roles: RoleSnapshot[] }, code: { permissions: string[]; roles: RoleSnapshot[] }): CatalogDiff {
  const dbPerms = new Set(db.permissions);
  const codePerms = new Set(code.permissions);
  const dbRoles = new Map(db.roles.map((r) => [r.key, r.grants]));

  const roles: RoleDiff[] = [];
  for (const r of code.roles) {
    const current = dbRoles.get(r.key);
    const cur = current ?? {};
    const d: RoleDiff = { role: r.key, newRole: !current, added: [], removed: [], changed: [] };
    for (const [permission, scope] of Object.entries(r.grants)) {
      if (!(permission in cur)) d.added.push({ permission, scope });
      else if (cur[permission] !== scope) d.changed.push({ permission, from: cur[permission]!, to: scope });
    }
    for (const [permission, scope] of Object.entries(cur)) {
      if (!(permission in r.grants)) d.removed.push({ permission, scope });
    }
    if (d.newRole || d.added.length || d.removed.length || d.changed.length) roles.push(d);
  }

  const codeRoleKeys = new Set(code.roles.map((r) => r.key));
  return {
    permissionsToAdd: [...codePerms].filter((p) => !dbPerms.has(p)).sort(),
    permissionsToRemove: [...dbPerms].filter((p) => !codePerms.has(p)).sort(),
    roles,
    unknownRoles: db.roles.map((r) => r.key).filter((k) => !codeRoleKeys.has(k)).sort(),
  };
}

export function renderCatalogDiff(d: CatalogDiff): string {
  const out: string[] = [];
  out.push(`Permissions to add (${d.permissionsToAdd.length}): ${d.permissionsToAdd.join(", ") || "-"}`);
  out.push(`Permissions to remove (${d.permissionsToRemove.length}): ${d.permissionsToRemove.join(", ") || "-"}`);
  if (!d.roles.length) out.push("Roles: no differences");
  for (const r of d.roles) {
    out.push(`\n[${r.role}]${r.newRole ? " (new role)" : ""}`);
    for (const a of r.added) out.push(`  + ${a.permission} (${a.scope})`);
    for (const c of r.changed) out.push(`  ~ ${c.permission}: ${c.from} -> ${c.to}`);
    for (const x of r.removed) out.push(`  - ${x.permission} (${x.scope})`);
  }
  if (d.unknownRoles.length) out.push(`\nSystem roles in the database but not in code (untouched): ${d.unknownRoles.join(", ")}`);
  return out.join("\n");
}
