import { pgEnum } from "drizzle-orm/pg-core";

export const organizationStatus = pgEnum("organization_status", ["ACTIVE", "SUSPENDED"]);

export const userStatus = pgEnum("user_status", ["ACTIVE", "DISABLED"]);

/**
 * How far a permission reaches:
 *  - ALL      every record in the organization
 *  - PROJECT  records that belong to projects the user is a member/manager of
 *  - ASSIGNED records explicitly assigned to the user (and still inside the assignment's project)
 */
export const permissionScope = pgEnum("permission_scope", ["ALL", "PROJECT", "ASSIGNED"]);

export const projectStatus = pgEnum("project_status", [
  "PLANNED",
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED",
  "ARCHIVED",
]);

export const vehicleStatus = pgEnum("vehicle_status", [
  "AVAILABLE",
  "ASSIGNED",
  "IN_MAINTENANCE",
  "OUT_OF_SERVICE",
  "ACCIDENT",
  "SOLD",
  "ARCHIVED",
]);

export const employeeStatus = pgEnum("employee_status", ["ACTIVE", "INACTIVE", "SUSPENDED", "ARCHIVED"]);

/**
 * Stored administrative driver status. "EXPIRED" is never stored: it is derived
 * at read time from the license expiry date (see services/expiry.ts).
 */
export const driverStatus = pgEnum("driver_status", ["ACTIVE", "SUSPENDED", "INACTIVE"]);

export const licenseType = pgEnum("license_type", ["PRIVATE", "PUBLIC", "HEAVY", "MOTORCYCLE", "OTHER"]);

export const documentType = pgEnum("vehicle_document_type", [
  "REGISTRATION",
  "INSURANCE",
  "LICENSE",
  "WARRANTY",
  "OWNERSHIP",
  "OTHER",
]);

export const coverageType = pgEnum("insurance_coverage_type", ["THIRD_PARTY", "COMPREHENSIVE", "OTHER"]);

export const assignmentType = pgEnum("assignment_type", [
  "PROJECT",
  "VEHICLE",
  "MAINTENANCE_REQUEST",
  "ACCIDENT",
  "INVOICE",
  "TASK",
  "DOCUMENT",
]);

export const assignmentStatus = pgEnum("assignment_status", [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

export const priority = pgEnum("priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);
