import { desc, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { vehicles } from "../src/db/schema/index.js";
import { sortOrder } from "../src/http/validate.js";
import { createProject, createVehicle, userAndClient } from "./helpers.js";

const render = (parts: ReturnType<typeof sortOrder>) => new PgDialect().sqlToQuery(sql.join(parts, sql`, `)).sql;

describe("sortOrder (whitelisted list sorting)", () => {
  const allowed = { plateNumber: vehicles.plateNumber, year: vehicles.year };
  const fallback = desc(vehicles.createdAt);

  it("applies a whitelisted column in either direction, empty values last, default order as tie-breaker", () => {
    expect(render(sortOrder({ sort: "plateNumber", dir: "asc" }, allowed, fallback))).toBe('"vehicles"."plate_number" asc nulls last, "vehicles"."created_at" desc');
    expect(render(sortOrder({ sort: "year" }, allowed, fallback))).toBe('"vehicles"."year" desc nulls last, "vehicles"."created_at" desc');
  });

  it("ignores unknown, prototype and injection-shaped keys (default order, nothing interpolated)", () => {
    for (const sort of ["nope", "constructor", "__proto__", "toString", "plateNumber; drop table vehicles", "plate_number"]) {
      expect(render(sortOrder({ sort, dir: "asc" }, allowed, fallback)), sort).toBe('"vehicles"."created_at" desc');
    }
    expect(render(sortOrder({}, allowed, fallback))).toBe('"vehicles"."created_at" desc');
  });
});

describe("list endpoints accept sort/dir", () => {
  it("vehicles: sorts the whole result set server-side (across pages), unknown keys keep the default order", async () => {
    const { client, user } = await userAndClient(["SUPER_ADMIN"]);
    const p = await createProject({ managerId: user.id });
    for (const [plate, year] of [["SRT-B", 2020], ["SRT-A", 2024], ["SRT-C", 2018]] as const) await createVehicle(p.id, { plateNumber: `${plate}-${p.code}`, year });
    const list = async (qs: string) => ((await client.get(`/api/vehicles?projectId=${p.id}&${qs}`)).body.data as { plateNumber: string; year: number }[]).map((v) => v.plateNumber.slice(0, 5));
    expect(await list("sort=plateNumber&dir=asc")).toEqual(["SRT-A", "SRT-B", "SRT-C"]);
    expect(await list("sort=plateNumber&dir=desc")).toEqual(["SRT-C", "SRT-B", "SRT-A"]);
    expect(await list("sort=year&dir=asc")).toEqual(["SRT-C", "SRT-B", "SRT-A"]);
    // page 1 of size 1 sorted ascending is the first of the full sorted set
    expect(await list("sort=plateNumber&dir=asc&pageSize=1&page=1")).toEqual(["SRT-A"]);
    expect(await list("sort=plateNumber&dir=asc&pageSize=1&page=3")).toEqual(["SRT-C"]);
    const def = await list("");
    expect(await list("sort=doesNotExist&dir=asc")).toEqual(def);
    expect((await client.get(`/api/vehicles?sort=x&dir=sideways`)).status).toBe(400); // dir is validated
  });

  it("every sortable list endpoint answers 200 with a sort parameter", async () => {
    const { client } = await userAndClient(["SUPER_ADMIN"]);
    for (const [path, key] of [
      ["/api/maintenance", "status"],
      ["/api/maintenance", "cost"],
      ["/api/invoices", "total"],
      ["/api/expenses", "amount"],
      ["/api/accidents", "severity"],
      ["/api/violations", "amount"],
      ["/api/fuel", "liters"],
      ["/api/handovers", "distance"],
      ["/api/employees", "fullName"],
      ["/api/drivers", "licenseExpiryDate"],
      ["/api/projects", "vehicleCount"],
    ]) {
      for (const dir of ["asc", "desc"]) expect((await client.get(`${path}?sort=${key}&dir=${dir}`)).status, `${path} ${key} ${dir}`).toBe(200);
    }
  });
});
