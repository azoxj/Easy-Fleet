import { and, ilike, or } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { projectScope, vehicleScope } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { projects, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";

/** Global search box. Every result set is filtered through the same scope predicates as the list endpoints. */
export const searchRouter = Router();

searchRouter.get("/", async (req, res) => {
  const { access } = ctx(req);
  const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
  const like = `%${q}%`;
  const [vehicleRows, projectRows] = await Promise.all([
    access.has("vehicles.read")
      ? db
          .select({ id: vehicles.id, plateNumber: vehicles.plateNumber, make: vehicles.make, model: vehicles.model, status: vehicles.status })
          .from(vehicles)
          .where(and(vehicleScope(access, "vehicles.read"), or(ilike(vehicles.plateNumber, like), ilike(vehicles.vehicleNumber, like), ilike(vehicles.vin, like))))
          .limit(6)
      : Promise.resolve([]),
    access.has("projects.read")
      ? db
          .select({ id: projects.id, name: projects.name, code: projects.code })
          .from(projects)
          .where(and(projectScope(access, "projects.read"), or(ilike(projects.name, like), ilike(projects.code, like))))
          .limit(6)
      : Promise.resolve([]),
  ]);
  res.json({ data: { vehicles: vehicleRows, projects: projectRows } });
});
