# Dependency audit (npm audit) — findings and treatment

Checked on 2026-10-29 against the registry. CI gate: `npm audit --omit=dev --audit-level=high` (production dependencies, high and above). The gate was not weakened.

## Before this change (production dependencies: 6 findings, 2 high)
| Package | Current | Severity | Path | Runs in production? | Fixed in | Breaking? |
|---|---|---|---|---|---|---|
| body-parser | 2.3.0 | **high** (DoS: trailing bytes after a compressed body) | `server → express@5.2.1 → body-parser` (indirect) | yes (request parsing) | 2.4.0 | no — inside express's range |
| zod | 4.6.5 | **high** (memory exhaustion on oversized constrained collections) | `server → zod` (direct) | yes (validation) | 4.6.6+ (now 4.6.7) | no |
| nodemailer | 10.0.13 | moderate (3 address-parser advisories) | `server → nodemailer` (direct) | yes (e-mail) | ≥ 10.1.4 (now 10.2.1) | no — same major |
| qs | 6.16.0 | moderate (`stringify` with `arrayFormat: comma` throws) | `server → express → qs` and `→ body-parser → qs` | yes (express's query parser); the application code does not import `qs` | 6.17.1 | no |
| uuid | 8.3.2 | moderate (missing bounds check in v3/v5/v6 **when `buf` is passed**) | `server → exceljs@4.4.0 → uuid` (indirect) | yes (Excel import/export) | uuid ≥ 11.1.1 | **yes** — see below |
| exceljs | 4.4.0 | moderate (only through uuid) | `server → exceljs` (direct) | yes | none: 4.4.0 is the latest release; npm's suggested "fix" is a **downgrade to 3.4.0** | **yes** |

Reachability of uuid: exceljs calls only `uuid.v4()` with no buffer argument (`exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`), so the vulnerable code path (v3/v5/v6 with `buf`) is not reachable from this application.

## Development-only findings (not in the CI gate; not in the released package)
| Package | Current | Severity | Path | Fixed in | Breaking? |
|---|---|---|---|---|---|
| vite | 8.3.1 | high (dev server: `launch-editor` argument escaping / editor flag handling) | `web → vite` | 8.3.5 | no |
| source-map-js | 1.2.1 | high (DoS on indexed source maps) | `web → @tailwindcss/vite → @tailwindcss/node → source-map-js` (build tooling) | 1.2.2 | no |
| vitest / @vitest/mocker | 5.0.1 | moderate (mock registration) | `server, web → vitest` | 5.0.5 | no |
| smtp-server | 3.19.16 | moderate (via nodemailer) | `server (devDependency, tests) → smtp-server` | 3.21.1 | no |
| esbuild 0.18.20 → @esbuild-kit/* → drizzle-kit | drizzle-kit 0.31.11 | moderate (esbuild dev-server request issue) | `server → drizzle-kit → @esbuild-kit/esm-loader → core-utils → esbuild` | none: 0.31.11 is the latest; npm's "fix" is a downgrade to 0.18.1 | yes |

## What this change does
`npm audit fix` (no `--force`), lockfile only; both `package.json` files are unchanged and every move stays inside the declared semver ranges:
body-parser 2.3.0→2.4.0, zod 4.6.5→4.6.7, nodemailer 10.0.13→10.2.1, qs 6.16.0→6.17.1; vite 8.3.1→8.3.5, source-map-js 1.2.1→1.2.2, vitest 5.0.1→5.0.5, smtp-server 3.19.16→3.21.1, plus their transitive packages (rolldown 1.2.11→1.2.15, postcss 8.5.28→8.5.32, chai, nanoid, magic-string, tinybench, tinyexec, std-env, why-is-node-running 2.3.0→3.2.1 and obug 2.2.1→3.0.0 — both test-runner internals).

After: `npm audit --omit=dev --audit-level=high` passes (0 high). Remaining (6, all moderate): uuid and exceljs (production), and the drizzle-kit/esbuild chain (4 entries, development only).

## Breaking items — separate remediation plan (not executed)
1. **uuid via exceljs** (not reachable, see above). Options, in order of preference:
   - **A. `overrides` in the root `package.json`: `"uuid": "^11.1.1"`** (exceljs only uses `v4()`, which has the same API). Smallest change; needs the import/export tests plus a manual Excel round-trip check (the vehicle import template and the 25-vehicle sample). Drawback: exceljs is unmaintained, so this is an override of a package its author did not test against.
   - B. Replace exceljs (vehicle import and its template in `modules/vehicles/import*.ts`) with a maintained library. Larger change, own PR and decision.
   - C. Record a time-limited, documented acceptance (the moderate finding does not fail the gate). No code change.
2. **drizzle-kit → esbuild 0.18.20** (development only, the advisory concerns esbuild's own dev server which drizzle-kit does not start). Wait for a drizzle-kit release that drops `@esbuild-kit`, or add an `overrides` entry for `@esbuild-kit/core-utils`'s esbuild after checking `drizzle-kit generate` still works. Never `npm audit fix --force` (it would install drizzle-kit 0.18.1 and exceljs 3.4.0).
