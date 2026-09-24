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

export const maintenancePriority = pgEnum("maintenance_priority", ["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const maintenanceStatus = pgEnum("maintenance_status", [
  "REQUESTED",
  "INSPECTION",
  "QUOTE_PENDING",
  "PENDING_APPROVAL",
  "APPROVED",
  "IN_REPAIR",
  "READY_FOR_HANDOVER",
  "ACCEPTED",
  "REJECTED",
  "CLOSED",
]);

export const quoteStatus = pgEnum("maintenance_quote_status", ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"]);

export const vendorStatus = pgEnum("vendor_status", ["ACTIVE", "INACTIVE"]);

export const maintenanceAttachmentCategory = pgEnum("maintenance_attachment_category", [
  "DAMAGE_PHOTO",
  "INSPECTION_REPORT",
  "QUOTE",
  "INVOICE",
  "REPAIR_PHOTO",
  "OTHER",
]);
