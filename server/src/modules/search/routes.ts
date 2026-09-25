import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { driverScope, employeeScope, maintenanceScope, projectScope, vehicleScope } from "../../auth/access.js";
import { db } from "../../db/client.js";
import { drivers, employees, insurancePolicies, invoices, maintenanceRequests, projects, vehicleDocuments, vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { invoiceScope } from "../finance/invoices.js";

/** Global search box. Every result set is filtered through the same scope predicates as the list endpoints. */
export const searchRouter = Router();

const LIMIT = 6;

searchRouter.get("/", async (req, res) => {
  const { access } = ctx(req);
  const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const mr = /^mr-?(\d+)$/i.exec(q);
  const inv = /^inv-?(\d+)$/i.exec(q);
  const none = Promise.resolve([]);

  const [vehicleRows, projectRows, employeeRows, driverRows, maintenanceRows, invoiceRows, documentRows, insuranceRows] = await Promise.all([
    access.has("vehicles.read")
      ? db
          .select({ id: vehicles.id, plateNumber: vehicles.plateNumber, plateArabic: vehicles.plateArabic, make: vehicles.make, model: vehicles.model, status: vehicles.status })
          .from(vehicles)
          .where(
            and(
              vehicleScope(access, "vehicles.read"),
              or(ilike(vehicles.plateNumber, like), ilike(vehicles.plateArabic, like), ilike(vehicles.plateEnglish, like), ilike(vehicles.serialNumber, like), ilike(vehicles.vehicleNumber, like), ilike(vehicles.vin, like)),
            ),
          )
          .limit(LIMIT)
      : none,
    access.has("projects.read")
      ? db
          .select({ id: projects.id, name: projects.name, code: projects.code })
          .from(projects)
          .where(and(projectScope(access, "projects.read"), or(ilike(projects.name, like), ilike(projects.code, like))))
          .limit(LIMIT)
      : none,
    access.has("employees.read")
      ? db
          .select({ id: employees.id, fullName: employees.fullName, employeeNumber: employees.employeeNumber, jobTitle: employees.jobTitle })
          .from(employees)
          .where(and(employeeScope(access, "employees.read"), or(ilike(employees.fullName, like), ilike(employees.employeeNumber, like), ilike(employees.phone, like), ilike(employees.email, like))))
          .limit(LIMIT)
      : none,
    access.has("drivers.read")
      ? db
          .select({ id: drivers.id, fullName: employees.fullName, licenseNumber: drivers.licenseNumber })
          .from(drivers)
          .innerJoin(employees, eq(employees.id, drivers.employeeId))
          .where(and(driverScope(access, "drivers.read"), isNull(drivers.archivedAt), or(ilike(employees.fullName, like), ilike(drivers.licenseNumber, like))))
          .limit(LIMIT)
      : none,
    access.has("maintenance.read")
      ? db
          .select({ id: maintenanceRequests.id, number: maintenanceRequests.number, issue: maintenanceRequests.issue, status: maintenanceRequests.status, plateNumber: vehicles.plateNumber })
          .from(maintenanceRequests)
          .innerJoin(vehicles, eq(vehicles.id, maintenanceRequests.vehicleId))
          .where(and(maintenanceScope(access, "maintenance.read"), mr ? eq(maintenanceRequests.number, Number(mr[1])) : or(ilike(maintenanceRequests.issue, like), ilike(vehicles.plateNumber, like))))
          .limit(LIMIT)
          .then((rows) => rows.map((r) => ({ ...r, label: `MR-${r.number}` })))
      : none,
    access.has("invoices.read")
      ? db
          .select({ id: invoices.id, number: invoices.number, invoiceNumber: invoices.invoiceNumber, description: invoices.description, status: invoices.status, total: invoices.total })
          .from(invoices)
          .where(and(invoiceScope(access), inv ? eq(invoices.number, Number(inv[1])) : or(ilike(invoices.invoiceNumber, like), ilike(invoices.description, like))))
          .limit(LIMIT)
          .then((rows) => rows.map((r) => ({ ...r, label: `INV-${r.number}` })))
      : none,
    access.has("vehicle_documents.read")
      ? db
          .select({ id: vehicleDocuments.id, vehicleId: vehicles.id, plateNumber: vehicles.plateNumber, documentType: vehicleDocuments.documentType, documentNumber: vehicleDocuments.documentNumber, expiryDate: vehicleDocuments.expiryDate })
          .from(vehicleDocuments)
          .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
          .where(and(vehicleScope(access, "vehicle_documents.read"), isNull(vehicleDocuments.deletedAt), ilike(vehicleDocuments.documentNumber, like)))
          .limit(LIMIT)
      : none,
    access.has("insurance.read")
      ? db
          .select({ id: insurancePolicies.id, vehicleId: vehicles.id, plateNumber: vehicles.plateNumber, provider: insurancePolicies.provider, policyNumber: insurancePolicies.policyNumber, expiryDate: insurancePolicies.expiryDate })
          .from(insurancePolicies)
          .innerJoin(vehicles, eq(vehicles.id, insurancePolicies.vehicleId))
          .where(and(vehicleScope(access, "insurance.read"), or(ilike(insurancePolicies.policyNumber, like), ilike(insurancePolicies.provider, like))))
          .limit(LIMIT)
      : none,
  ]);
  res.json({
    data: {
      vehicles: vehicleRows,
      projects: projectRows,
      employees: employeeRows,
      drivers: driverRows,
      maintenance: maintenanceRows,
      invoices: invoiceRows,
      documents: [...documentRows.map((d) => ({ ...d, kind: "VEHICLE_DOCUMENT" })), ...insuranceRows.map((d) => ({ ...d, kind: "INSURANCE" }))],
    },
  });
});
