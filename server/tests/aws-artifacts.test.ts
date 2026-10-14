import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FILE_SECRET_KEYS } from "../src/config.js";

/** Drift guards for the AWS deployment files (they are not executed in CI, so their contents are checked here). */
const root = path.resolve("..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const service = read("deploy/aws/easy-fleet.service");
const caddyA = read("deploy/aws/Caddyfile");
const caddyB = read("deploy/aws/Caddyfile.alb");
const envExample = read("deploy/aws/easy-fleet.env.example");
const configSource = readFileSync(path.resolve("src/config.ts"), "utf8");

describe("systemd unit", () => {
  it("runs as an unprivileged user, restarts always, stops gracefully", () => {
    expect(service).toMatch(/^User=easyfleet$/m);
    expect(service).not.toMatch(/^User=root/m);
    expect(service).toMatch(/^Restart=always$/m);
    expect(service).toMatch(/^RestartSec=\d+$/m);
    expect(service).toMatch(/^EnvironmentFile=\/etc\/easy-fleet\/easy-fleet\.env$/m);
    expect(service).toMatch(/^WorkingDirectory=\/opt\/easy-fleet\/current\/server$/m);
    expect(service).toMatch(/^ExecStart=\/usr\/bin\/node \/opt\/easy-fleet\/current\/server\/dist\/index\.js$/m);
    expect(service).toMatch(/^KillSignal=SIGTERM$/m);
    expect(service).toMatch(/^NoNewPrivileges=true$/m);
    expect(service).toMatch(/^ProtectSystem=strict$/m);
    // the unit waits longer than the application's own grace period
    const stop = Number(/^TimeoutStopSec=(\d+)$/m.exec(service)![1]);
    const grace = Number(/SHUTDOWN_TIMEOUT_SECONDS: z\.coerce\.number\(\)[^\n]*default\((\d+)\)/.exec(configSource)![1]);
    expect(stop).toBeGreaterThan(grace);
    expect(service).not.toMatch(/pm2/i);
  });
});

describe("reverse proxy", () => {
  it.each([
    ["A (Caddy on the edge)", caddyA],
    ["B (behind an ALB)", caddyB],
  ])("%s redacts handover tokens and secret headers, compresses and caps uploads", (_n, c) => {
    expect(c).toContain("request>uri regexp (/h/)[A-Za-z0-9_-]+ $1[redacted]");
    expect(c).toContain("request>uri regexp (/public/handover/)[A-Za-z0-9_-]+ $1[redacted]");
    for (const h of ["Cookie", "Authorization", "X-Csrf-Token", "Referer"]) expect(c).toContain(`request>headers>${h} delete`);
    expect(c).toContain("resp_headers>Set-Cookie delete");
    expect(c).toContain("encode zstd gzip");
    expect(c).toMatch(/max_size 12MB/);
    expect(c).toContain("reverse_proxy 127.0.0.1:4000");
    expect(c).toContain("health_uri /api/healthz");
    expect(c).not.toMatch(/\{[0-9]+,\}/); // braces in a Caddyfile are placeholders
  });

  it("A terminates TLS itself with a real certificate; B documents the ALB log and hop-count pitfalls", () => {
    expect(caddyA).toMatch(/TRUST_PROXY=1/);
    expect(caddyA).not.toContain("auto_https off");
    expect(caddyB).toContain("auto_https off");
    expect(caddyB).toMatch(/TRUST_PROXY = number of proxies/);
    expect(caddyB).toMatch(/DO NOT enable ALB or CloudFront access logs/);
  });
});

describe("environment template", () => {
  const assignments = envExample
    .split("\n")
    .map((l) => /^(#\s*)?([A-Z][A-Z0-9_]+)=(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ commented: !!m[1], key: m[2]!, value: m[3]! }));
  const known = new Set<string>([
    ...[...configSource.matchAll(/^  ([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!),
    ...FILE_SECRET_KEYS.map((k) => `${k}_FILE`),
    "BOOTSTRAP_ADMIN_EMAIL", // read by scripts/bootstrap.ts
    "BOOTSTRAP_ADMIN_NAME",
    "EF_FORBID_DEMO_SEED", // read by scripts/seed-demo.ts (lib/db-identity.ts)
  ]);

  it("only contains variables the application reads", () => {
    const unknown = assignments.filter((a) => !known.has(a.key)).map((a) => a.key);
    expect(unknown).toEqual([]);
  });

  it("holds no secret: credentials only through NAME_FILE paths", () => {
    for (const a of assignments) {
      if (/(PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL|SETTINGS_KEY|INTEGRATION_ID|SMTP_USER)$/.test(a.key)) expect(a.value, a.key).toBe("");
      if ((FILE_SECRET_KEYS as readonly string[]).map((k) => `${k}_FILE`).includes(a.key)) expect(a.value, a.key).toMatch(/^\/run\/easy-fleet\/secrets\/[A-Z_]+$/);
    }
    expect(envExample).not.toMatch(/AKIA[0-9A-Z]{16}|aws_secret_access_key|postgres:\/\/[^\s]*:[^\s]*@/i);
  });

  it("uses the production-safe values the guide promises", () => {
    const v = (k: string) => assignments.find((a) => a.key === k && !a.commented)?.value;
    expect(v("NODE_ENV")).toBe("production");
    expect(v("COOKIE_SECURE")).toBe("true");
    expect(v("STORAGE_PROVIDER")).toBe("s3");
    expect(v("DB_SSL")).toBe("verify-full");
    expect(v("TRUST_PROXY")).toBe("1");
    expect(v("LOG_FORMAT")).toBe("json");
  });
});

describe("scripts", () => {
  it("shell scripts are syntactically valid and the safety interlocks are in place", () => {
    for (const f of ["deploy.sh", "fetch-secrets.sh", "package-release.sh"]) {
      const r = spawnSync("bash", ["-n", path.join(root, "deploy/aws", f)], { encoding: "utf8" });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
    const deploy = read("deploy/aws/deploy.sh");
    expect(deploy).toContain('CONFIRM_BACKUP');
    expect(deploy).toMatch(/migrate\.js/);
    expect(deploy).toMatch(/wait_ready/);
  });

  it("the secrets fetcher writes exactly the names the application can read from files", () => {
    const allowed = /ALLOWED='([^']+)'/.exec(read("deploy/aws/fetch-secrets.sh"))![1]!.split(" ").sort();
    expect(allowed).toEqual([...FILE_SECRET_KEYS].sort());
    expect(read("deploy/aws/fetch-secrets.sh")).not.toMatch(/\becho\b[^\n]*\$json|printf[^\n]*\$json/);
  });
});

describe("CI/CD and the Render environment", () => {
  it("CI uses no secrets and gates on typecheck, tests, build and the production dependency audit", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/secrets\./);
    for (const step of ["npm run typecheck", "npm test", "npm run build", "npm audit --omit=dev"]) expect(ci).toContain(step);
    expect(ci).toMatch(/postgres:16/);
  });

  it("the AWS deploy workflow is only an inactive template: manual, approval-gated, OIDC (no stored keys)", () => {
    expect(existsSync(path.join(root, ".github/workflows/deploy-aws.yml"))).toBe(false);
    const t = read(".github/workflows/deploy-aws.yml.example");
    expect(t).toMatch(/workflow_dispatch/);
    expect(t).not.toMatch(/^\s*push:/m);
    expect(t).toMatch(/environment: production/);
    expect(t).toMatch(/role-to-assume/);
    expect(t).not.toMatch(/aws-secret-access-key|AWS_SECRET_ACCESS_KEY/i);
  });

  it("Render is untouched and still deployable", () => {
    const render = read("render.yaml");
    expect(render).toContain("autoDeploy: true");
    expect(render).toContain("branch: claude/easy-fleet-sprint-1");
    expect(render).toMatch(/key: TRUST_PROXY/);
    expect(existsSync(path.join(root, "docs/DEPLOYMENT-RENDER.md"))).toBe(true);
  });

  it("the AWS documents exist and name the S3 provider directory (not hidden by .gitignore)", () => {
    for (const d of ["docs/AWS-DEPLOYMENT.md", "docs/AWS-PRODUCTION-CHECKLIST.md"]) expect(existsSync(path.join(root, d)), d).toBe(true);
    const ignored = spawnSync("git", ["check-ignore", "-q", "server/src/services/object-storage/s3.ts"], { cwd: root });
    expect(ignored.status).toBe(1); // 1 = not ignored
  });
});
