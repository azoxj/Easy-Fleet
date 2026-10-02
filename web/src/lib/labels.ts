import { t } from "../i18n";
export type Tone = "gray" | "blue" | "green" | "amber" | "red" | "violet" | "slate";

type LabelMap = Record<string, { label: string; tone: Tone }>;

export const VEHICLE_STATUS: LabelMap = {
  AVAILABLE: { get label() { return t("enums.vehicleStatus.AVAILABLE"); }, tone: "green" },
  ASSIGNED: { get label() { return t("enums.vehicleStatus.ASSIGNED"); }, tone: "blue" },
  IN_MAINTENANCE: { get label() { return t("enums.vehicleStatus.IN_MAINTENANCE"); }, tone: "amber" },
  OUT_OF_SERVICE: { get label() { return t("enums.vehicleStatus.OUT_OF_SERVICE"); }, tone: "red" },
  ACCIDENT: { get label() { return t("enums.vehicleStatus.ACCIDENT"); }, tone: "red" },
  SOLD: { get label() { return t("enums.vehicleStatus.SOLD"); }, tone: "violet" },
  ARCHIVED: { get label() { return t("enums.vehicleStatus.ARCHIVED"); }, tone: "gray" },
};

export const PROJECT_STATUS: LabelMap = {
  PLANNED: { get label() { return t("enums.projectStatus.PLANNED"); }, tone: "slate" },
  ACTIVE: { get label() { return t("enums.projectStatus.ACTIVE"); }, tone: "green" },
  ON_HOLD: { get label() { return t("enums.projectStatus.ON_HOLD"); }, tone: "amber" },
  COMPLETED: { get label() { return t("enums.projectStatus.COMPLETED"); }, tone: "blue" },
  ARCHIVED: { get label() { return t("enums.projectStatus.ARCHIVED"); }, tone: "gray" },
};

export const ASSIGNMENT_STATUS: LabelMap = {
  PENDING: { get label() { return t("enums.assignmentStatus.PENDING"); }, tone: "amber" },
  IN_PROGRESS: { get label() { return t("enums.assignmentStatus.IN_PROGRESS"); }, tone: "blue" },
  COMPLETED: { get label() { return t("enums.assignmentStatus.COMPLETED"); }, tone: "green" },
  CANCELLED: { get label() { return t("enums.assignmentStatus.CANCELLED"); }, tone: "gray" },
};

export const ASSIGNMENT_TYPE: Record<string, string> = {
  get PROJECT() { return t("enums.assignmentType.PROJECT"); },
  get VEHICLE() { return t("enums.assignmentType.VEHICLE"); },
  get MAINTENANCE_REQUEST() { return t("enums.assignmentType.MAINTENANCE_REQUEST"); },
  get ACCIDENT() { return t("enums.assignmentType.ACCIDENT"); },
  get INVOICE() { return t("enums.assignmentType.INVOICE"); },
  get TASK() { return t("enums.assignmentType.TASK"); },
  get DOCUMENT() { return t("enums.assignmentType.DOCUMENT"); },
  get VIOLATION() { return t("enums.assignmentType.VIOLATION"); },
  get REGISTRATION() { return t("enums.assignmentType.REGISTRATION"); },
  get INSURANCE() { return t("enums.assignmentType.INSURANCE"); },
};

export const PRIORITY: LabelMap = {
  LOW: { get label() { return t("enums.priority.LOW"); }, tone: "slate" },
  MEDIUM: { get label() { return t("enums.priority.MEDIUM"); }, tone: "blue" },
  HIGH: { get label() { return t("enums.priority.HIGH"); }, tone: "amber" },
  URGENT: { get label() { return t("enums.priority.URGENT"); }, tone: "red" },
};

export const EMPLOYEE_STATUS: LabelMap = {
  ACTIVE: { get label() { return t("enums.employeeStatus.ACTIVE"); }, tone: "green" },
  INACTIVE: { get label() { return t("enums.employeeStatus.INACTIVE"); }, tone: "slate" },
  SUSPENDED: { get label() { return t("enums.employeeStatus.SUSPENDED"); }, tone: "amber" },
  ARCHIVED: { get label() { return t("enums.employeeStatus.ARCHIVED"); }, tone: "gray" },
};

export const DRIVER_STATUS: LabelMap = {
  ACTIVE: { get label() { return t("enums.driverStatus.ACTIVE"); }, tone: "green" },
  EXPIRED: { get label() { return t("enums.driverStatus.EXPIRED"); }, tone: "red" },
  SUSPENDED: { get label() { return t("enums.driverStatus.SUSPENDED"); }, tone: "amber" },
  INACTIVE: { get label() { return t("enums.driverStatus.INACTIVE"); }, tone: "gray" },
};

export const EXPIRY_STATUS: LabelMap = {
  ACTIVE: { get label() { return t("enums.expiryStatus.ACTIVE"); }, tone: "green" },
  EXPIRING_SOON: { get label() { return t("enums.expiryStatus.EXPIRING_SOON"); }, tone: "amber" },
  EXPIRED: { get label() { return t("enums.expiryStatus.EXPIRED"); }, tone: "red" },
};

export const LICENSE_TYPE: Record<string, string> = {
  get PRIVATE() { return t("enums.licenseType.PRIVATE"); },
  get PUBLIC() { return t("enums.licenseType.PUBLIC"); },
  get HEAVY() { return t("enums.licenseType.HEAVY"); },
  get MOTORCYCLE() { return t("enums.licenseType.MOTORCYCLE"); },
  get OTHER() { return t("enums.licenseType.OTHER"); },
};

export const DOCUMENT_TYPE: Record<string, string> = {
  get REGISTRATION() { return t("enums.documentType.REGISTRATION"); },
  get INSURANCE() { return t("enums.documentType.INSURANCE"); },
  get LICENSE() { return t("enums.documentType.LICENSE"); },
  get WARRANTY() { return t("enums.documentType.WARRANTY"); },
  get OWNERSHIP() { return t("enums.documentType.OWNERSHIP"); },
  get OTHER() { return t("enums.documentType.OTHER"); },
};

export const COVERAGE_TYPE: Record<string, string> = {
  get THIRD_PARTY() { return t("enums.coverageType.THIRD_PARTY"); },
  get COMPREHENSIVE() { return t("enums.coverageType.COMPREHENSIVE"); },
  get OTHER() { return t("enums.coverageType.OTHER"); },
};

export const USER_STATUS: LabelMap = {
  ACTIVE: { get label() { return t("enums.userStatus.ACTIVE"); }, tone: "green" },
  DISABLED: { get label() { return t("enums.userStatus.DISABLED"); }, tone: "gray" },
};

export const SCOPE_LABEL: Record<string, string> = {
  get ALL() { return t("enums.scopeLabel.ALL"); },
  get PROJECT() { return t("enums.scopeLabel.PROJECT"); },
  get ASSIGNED() { return t("enums.scopeLabel.ASSIGNED"); },
};

export const AUDIT_ACTION: Record<string, string> = {
  get AUTH_LOGIN() { return t("enums.auditAction.AUTH_LOGIN"); },
  get AUTH_LOGIN_FAILED() { return t("enums.auditAction.AUTH_LOGIN_FAILED"); },
  get AUTH_LOGOUT() { return t("enums.auditAction.AUTH_LOGOUT"); },
  get AUTH_PASSWORD_CHANGED() { return t("enums.auditAction.AUTH_PASSWORD_CHANGED"); },
  get AUTH_PASSWORD_RESET_REQUESTED() { return t("enums.auditAction.AUTH_PASSWORD_RESET_REQUESTED"); },
  get AUTH_PASSWORD_RESET_COMPLETED() { return t("enums.auditAction.AUTH_PASSWORD_RESET_COMPLETED"); },
  get EMAIL_SENT() { return t("enums.auditAction.EMAIL_SENT"); },
  get EMAIL_FAILED() { return t("enums.auditAction.EMAIL_FAILED"); },
  get EMAIL_SETTINGS_UPDATED() { return t("enums.auditAction.EMAIL_SETTINGS_UPDATED"); },
  get USER_CREATED() { return t("enums.auditAction.USER_CREATED"); },
  get USER_UPDATED() { return t("enums.auditAction.USER_UPDATED"); },
  get USER_ROLES_CHANGED() { return t("enums.auditAction.USER_ROLES_CHANGED"); },
  get USER_DISABLED() { return t("enums.auditAction.USER_DISABLED"); },
  get USER_ENABLED() { return t("enums.auditAction.USER_ENABLED"); },
  get USER_PASSWORD_RESET() { return t("enums.auditAction.USER_PASSWORD_RESET"); },
  get PROJECT_CREATED() { return t("enums.auditAction.PROJECT_CREATED"); },
  get PROJECT_UPDATED() { return t("enums.auditAction.PROJECT_UPDATED"); },
  get PROJECT_MEMBER_ADDED() { return t("enums.auditAction.PROJECT_MEMBER_ADDED"); },
  get PROJECT_MEMBER_REMOVED() { return t("enums.auditAction.PROJECT_MEMBER_REMOVED"); },
  get VEHICLE_CREATED() { return t("enums.auditAction.VEHICLE_CREATED"); },
  get VEHICLE_UPDATED() { return t("enums.auditAction.VEHICLE_UPDATED"); },
  get VEHICLE_ARCHIVED() { return t("enums.auditAction.VEHICLE_ARCHIVED"); },
  get ASSIGNMENT_CREATED() { return t("enums.auditAction.ASSIGNMENT_CREATED"); },
  get ASSIGNMENT_STATUS_CHANGED() { return t("enums.auditAction.ASSIGNMENT_STATUS_CHANGED"); },
  get EMPLOYEE_CREATED() { return t("enums.auditAction.EMPLOYEE_CREATED"); },
  get EMPLOYEE_UPDATED() { return t("enums.auditAction.EMPLOYEE_UPDATED"); },
  get EMPLOYEE_ARCHIVED() { return t("enums.auditAction.EMPLOYEE_ARCHIVED"); },
  get DRIVER_CREATED() { return t("enums.auditAction.DRIVER_CREATED"); },
  get DRIVER_UPDATED() { return t("enums.auditAction.DRIVER_UPDATED"); },
  get DRIVER_ARCHIVED() { return t("enums.auditAction.DRIVER_ARCHIVED"); },
  get VEHICLE_DRIVER_CHANGED() { return t("enums.auditAction.VEHICLE_DRIVER_CHANGED"); },
  get VEHICLE_DOCUMENT_ADDED() { return t("enums.auditAction.VEHICLE_DOCUMENT_ADDED"); },
  get VEHICLE_DOCUMENT_UPDATED() { return t("enums.auditAction.VEHICLE_DOCUMENT_UPDATED"); },
  get VEHICLE_DOCUMENT_DELETED() { return t("enums.auditAction.VEHICLE_DOCUMENT_DELETED"); },
  get REGISTRATION_ADDED() { return t("enums.auditAction.REGISTRATION_ADDED"); },
  get REGISTRATION_UPDATED() { return t("enums.auditAction.REGISTRATION_UPDATED"); },
  get INSURANCE_ADDED() { return t("enums.auditAction.INSURANCE_ADDED"); },
  get INSURANCE_UPDATED() { return t("enums.auditAction.INSURANCE_UPDATED"); },
  get FILE_UPLOADED() { return t("enums.auditAction.FILE_UPLOADED"); },
  get FILE_DOWNLOADED() { return t("enums.auditAction.FILE_DOWNLOADED"); },
  get VENDOR_CREATED() { return t("enums.auditAction.VENDOR_CREATED"); },
  get MAINTENANCE_CREATED() { return t("enums.auditAction.MAINTENANCE_CREATED"); },
  get MAINTENANCE_UPDATED() { return t("enums.auditAction.MAINTENANCE_UPDATED"); },
  get MAINTENANCE_ASSIGNED() { return t("enums.auditAction.MAINTENANCE_ASSIGNED"); },
  get MAINTENANCE_INSPECTION_STARTED() { return t("enums.auditAction.MAINTENANCE_INSPECTION_STARTED"); },
  get MAINTENANCE_INSPECTION_COMPLETED() { return t("enums.auditAction.MAINTENANCE_INSPECTION_COMPLETED"); },
  get MAINTENANCE_APPROVED() { return t("enums.auditAction.MAINTENANCE_APPROVED"); },
  get MAINTENANCE_REJECTED() { return t("enums.auditAction.MAINTENANCE_REJECTED"); },
  get MAINTENANCE_REPAIR_STARTED() { return t("enums.auditAction.MAINTENANCE_REPAIR_STARTED"); },
  get MAINTENANCE_READY_FOR_HANDOVER() { return t("enums.auditAction.MAINTENANCE_READY_FOR_HANDOVER"); },
  get MAINTENANCE_HANDOVER_ACCEPTED() { return t("enums.auditAction.MAINTENANCE_HANDOVER_ACCEPTED"); },
  get MAINTENANCE_HANDOVER_REJECTED() { return t("enums.auditAction.MAINTENANCE_HANDOVER_REJECTED"); },
  get MAINTENANCE_CLOSED() { return t("enums.auditAction.MAINTENANCE_CLOSED"); },
  get MAINTENANCE_STATUS_CHANGED() { return t("enums.auditAction.MAINTENANCE_STATUS_CHANGED"); },
  get QUOTE_CREATED() { return t("enums.auditAction.QUOTE_CREATED"); },
  get QUOTE_UPDATED() { return t("enums.auditAction.QUOTE_UPDATED"); },
  get QUOTE_SUBMITTED() { return t("enums.auditAction.QUOTE_SUBMITTED"); },
  get QUOTE_REVIEW_STARTED() { return t("enums.auditAction.QUOTE_REVIEW_STARTED"); },
  get QUOTE_APPROVED() { return t("enums.auditAction.QUOTE_APPROVED"); },
  get QUOTE_REJECTED() { return t("enums.auditAction.QUOTE_REJECTED"); },
  get PART_ADDED() { return t("enums.auditAction.PART_ADDED"); },
  get PART_UPDATED() { return t("enums.auditAction.PART_UPDATED"); },
  get PART_REMOVED() { return t("enums.auditAction.PART_REMOVED"); },
  get LABOR_ADDED() { return t("enums.auditAction.LABOR_ADDED"); },
  get LABOR_UPDATED() { return t("enums.auditAction.LABOR_UPDATED"); },
  get LABOR_REMOVED() { return t("enums.auditAction.LABOR_REMOVED"); },
  get PROJECT_ARCHIVED() { return t("enums.auditAction.PROJECT_ARCHIVED"); },
  get USER_DELETED() { return t("enums.auditAction.USER_DELETED"); },
  get VENDOR_UPDATED() { return t("enums.auditAction.VENDOR_UPDATED"); },
  get INVOICE_CREATED() { return t("enums.auditAction.INVOICE_CREATED"); },
  get INVOICE_UPDATED() { return t("enums.auditAction.INVOICE_UPDATED"); },
  get INVOICE_SUBMITTED() { return t("enums.auditAction.INVOICE_SUBMITTED"); },
  get INVOICE_REVIEW_STARTED() { return t("enums.auditAction.INVOICE_REVIEW_STARTED"); },
  get INVOICE_APPROVED() { return t("enums.auditAction.INVOICE_APPROVED"); },
  get INVOICE_REJECTED() { return t("enums.auditAction.INVOICE_REJECTED"); },
  get INVOICE_CANCELLED() { return t("enums.auditAction.INVOICE_CANCELLED"); },
  get INVOICE_TRANSFERRED() { return t("enums.auditAction.INVOICE_TRANSFERRED"); },
  get INVOICE_PAID() { return t("enums.auditAction.INVOICE_PAID"); },
  get INVOICE_STATUS_CHANGED() { return t("enums.auditAction.INVOICE_STATUS_CHANGED"); },
  get EXPENSE_CREATED() { return t("enums.auditAction.EXPENSE_CREATED"); },
  get EXPENSE_APPROVED() { return t("enums.auditAction.EXPENSE_APPROVED"); },
  get EXPENSE_REJECTED() { return t("enums.auditAction.EXPENSE_REJECTED"); },
  get FUEL_CREATED() { return t("enums.auditAction.FUEL_CREATED"); },
  get ACCIDENT_CREATED() { return t("enums.auditAction.ACCIDENT_CREATED"); },
  get ACCIDENT_UPDATED() { return t("enums.auditAction.ACCIDENT_UPDATED"); },
  get ACCIDENT_STATUS_CHANGED() { return t("enums.auditAction.ACCIDENT_STATUS_CHANGED"); },
  get VIOLATION_CREATED() { return t("enums.auditAction.VIOLATION_CREATED"); },
  get VIOLATION_UPDATED() { return t("enums.auditAction.VIOLATION_UPDATED"); },
  get VIOLATION_STATUS_CHANGED() { return t("enums.auditAction.VIOLATION_STATUS_CHANGED"); },
  get EMPLOYEE_DOCUMENT_ADDED() { return t("enums.auditAction.EMPLOYEE_DOCUMENT_ADDED"); },
  get EMPLOYEE_DOCUMENT_UPDATED() { return t("enums.auditAction.EMPLOYEE_DOCUMENT_UPDATED"); },
  get EMPLOYEE_DOCUMENT_DELETED() { return t("enums.auditAction.EMPLOYEE_DOCUMENT_DELETED"); },
  get HANDOVER_CREATED() { return t("enums.auditAction.HANDOVER_CREATED"); },
  get HANDOVER_LINK_ROTATED() { return t("enums.auditAction.HANDOVER_LINK_ROTATED"); },
  get HANDOVER_PHOTO_UPLOADED() { return t("enums.auditAction.HANDOVER_PHOTO_UPLOADED"); },
  get HANDOVER_COMPLETED() { return t("enums.auditAction.HANDOVER_COMPLETED"); },
  get HANDOVER_RETURN_COMPLETED() { return t("enums.auditAction.HANDOVER_RETURN_COMPLETED"); },
  get HANDOVER_CLOSED() { return t("enums.auditAction.HANDOVER_CLOSED"); },
  get HANDOVER_CANCELLED() { return t("enums.auditAction.HANDOVER_CANCELLED"); },
  get HANDOVER_TOKEN_INVALID() { return t("enums.auditAction.HANDOVER_TOKEN_INVALID"); },
  get TRIP_STARTED() { return t("enums.auditAction.TRIP_STARTED"); },
  get TRIP_ENDED() { return t("enums.auditAction.TRIP_ENDED"); },
  get ASSIGNMENT_UPDATED() { return t("enums.auditAction.ASSIGNMENT_UPDATED"); },
  get ASSIGNMENT_DELETED() { return t("enums.auditAction.ASSIGNMENT_DELETED"); },
  get NOTIFICATION_BROADCAST() { return t("enums.auditAction.NOTIFICATION_BROADCAST"); },
  get SETTINGS_UPDATED() { return t("enums.auditAction.SETTINGS_UPDATED"); },
  get REPORT_EXPORTED() { return t("enums.auditAction.REPORT_EXPORTED"); },
  get SECURITY_CSRF_REJECTED() { return t("enums.auditAction.SECURITY_CSRF_REJECTED"); },
  get SECURITY_RATE_LIMITED() { return t("enums.auditAction.SECURITY_RATE_LIMITED"); },
};

export const INVOICE_STATUS: LabelMap = {
  DRAFT: { get label() { return t("enums.invoiceStatus.DRAFT"); }, tone: "slate" },
  SUBMITTED: { get label() { return t("enums.invoiceStatus.SUBMITTED"); }, tone: "blue" },
  UNDER_REVIEW: { get label() { return t("enums.invoiceStatus.UNDER_REVIEW"); }, tone: "blue" },
  APPROVED: { get label() { return t("enums.invoiceStatus.APPROVED"); }, tone: "green" },
  REJECTED: { get label() { return t("enums.invoiceStatus.REJECTED"); }, tone: "red" },
  TRANSFER_PENDING: { get label() { return t("enums.invoiceStatus.TRANSFER_PENDING"); }, tone: "amber" },
  TRANSFERRED: { get label() { return t("enums.invoiceStatus.TRANSFERRED"); }, tone: "green" },
  PAID: { get label() { return t("enums.invoiceStatus.PAID"); }, tone: "green" },
  CANCELLED: { get label() { return t("enums.invoiceStatus.CANCELLED"); }, tone: "gray" },
};

export const EXPENSE_STATUS: LabelMap = {
  SUBMITTED: { get label() { return t("enums.expenseStatus.SUBMITTED"); }, tone: "amber" },
  APPROVED: { get label() { return t("enums.expenseStatus.APPROVED"); }, tone: "green" },
  REJECTED: { get label() { return t("enums.expenseStatus.REJECTED"); }, tone: "red" },
};

export const COST_CATEGORY: Record<string, string> = {
  get FUEL() { return t("enums.costCategory.FUEL"); },
  get MAINTENANCE() { return t("enums.costCategory.MAINTENANCE"); },
  get INSURANCE() { return t("enums.costCategory.INSURANCE"); },
  get REGISTRATION() { return t("enums.costCategory.REGISTRATION"); },
  get ACCIDENT() { return t("enums.costCategory.ACCIDENT"); },
  get VIOLATION() { return t("enums.costCategory.VIOLATION"); },
  get OTHER() { return t("enums.costCategory.OTHER"); },
};

export const ACCIDENT_STATUS: LabelMap = {
  OPEN: { get label() { return t("enums.accidentStatus.OPEN"); }, tone: "red" },
  UNDER_REVIEW: { get label() { return t("enums.accidentStatus.UNDER_REVIEW"); }, tone: "blue" },
  INSURANCE: { get label() { return t("enums.accidentStatus.INSURANCE"); }, tone: "blue" },
  REPAIR: { get label() { return t("enums.accidentStatus.REPAIR"); }, tone: "amber" },
  CLOSED: { get label() { return t("enums.accidentStatus.CLOSED"); }, tone: "gray" },
};

export const ACCIDENT_SEVERITY: LabelMap = {
  MINOR: { get label() { return t("enums.accidentSeverity.MINOR"); }, tone: "slate" },
  MODERATE: { get label() { return t("enums.accidentSeverity.MODERATE"); }, tone: "amber" },
  SEVERE: { get label() { return t("enums.accidentSeverity.SEVERE"); }, tone: "red" },
  CRITICAL: { get label() { return t("enums.accidentSeverity.CRITICAL"); }, tone: "red" },
};

export const RESPONSIBILITY: Record<string, string> = {
  get DRIVER() { return t("enums.responsibility.DRIVER"); },
  get THIRD_PARTY() { return t("enums.responsibility.THIRD_PARTY"); },
  get SHARED() { return t("enums.responsibility.SHARED"); },
  get UNKNOWN() { return t("enums.responsibility.UNKNOWN"); },
};

export const VIOLATION_STATUS: LabelMap = {
  OPEN: { get label() { return t("enums.violationStatus.OPEN"); }, tone: "red" },
  PAID: { get label() { return t("enums.violationStatus.PAID"); }, tone: "green" },
  DISPUTED: { get label() { return t("enums.violationStatus.DISPUTED"); }, tone: "violet" },
  CANCELLED: { get label() { return t("enums.violationStatus.CANCELLED"); }, tone: "gray" },
};

export const HANDOVER_STATUS: LabelMap = {
  PENDING_HANDOVER: { get label() { return t("enums.handoverStatus.PENDING_HANDOVER"); }, tone: "amber" },
  RETURN_PENDING: { get label() { return t("enums.handoverStatus.RETURN_PENDING"); }, tone: "blue" },
  RETURN_COMPLETED: { get label() { return t("enums.handoverStatus.RETURN_COMPLETED"); }, tone: "violet" },
  CLOSED: { get label() { return t("enums.handoverStatus.CLOSED"); }, tone: "gray" },
  CANCELLED: { get label() { return t("enums.handoverStatus.CANCELLED"); }, tone: "gray" },
};

export const PHOTO_CATEGORY: Record<string, string> = {
  get FRONT() { return t("enums.photoCategory.FRONT"); },
  get REAR() { return t("enums.photoCategory.REAR"); },
  get LEFT() { return t("enums.photoCategory.LEFT"); },
  get RIGHT() { return t("enums.photoCategory.RIGHT"); },
  get INTERIOR() { return t("enums.photoCategory.INTERIOR"); },
  get ODOMETER() { return t("enums.photoCategory.ODOMETER"); },
  get TIRES() { return t("enums.photoCategory.TIRES"); },
  get OTHER() { return t("enums.photoCategory.OTHER"); },
  get SIGNATURE() { return t("enums.photoCategory.SIGNATURE"); },
};

export const NOTIFICATION_CATEGORY: Record<string, string> = {
  get MAINTENANCE() { return t("enums.notificationCategory.MAINTENANCE"); },
  get FINANCE() { return t("enums.notificationCategory.FINANCE"); },
  get ASSIGNMENT() { return t("enums.notificationCategory.ASSIGNMENT"); },
  get DOCUMENT_EXPIRY() { return t("enums.notificationCategory.DOCUMENT_EXPIRY"); },
  get ACCIDENT() { return t("enums.notificationCategory.ACCIDENT"); },
  get VIOLATION() { return t("enums.notificationCategory.VIOLATION"); },
  get HANDOVER() { return t("enums.notificationCategory.HANDOVER"); },
  get SYSTEM() { return t("enums.notificationCategory.SYSTEM"); },
};

export const EMPLOYEE_DOC_TYPE: Record<string, string> = {
  get NATIONAL_ID() { return t("enums.employeeDocType.NATIONAL_ID"); },
  get IQAMA() { return t("enums.employeeDocType.IQAMA"); },
  get PASSPORT() { return t("enums.employeeDocType.PASSPORT"); },
  get CONTRACT() { return t("enums.employeeDocType.CONTRACT"); },
  get DRIVING_LICENSE() { return t("enums.employeeDocType.DRIVING_LICENSE"); },
  get OTHER() { return t("enums.employeeDocType.OTHER"); },
};

export const DOC_KIND: Record<string, string> = {
  get VEHICLE() { return t("enums.docKind.VEHICLE"); },
  get INSURANCE() { return t("enums.docKind.INSURANCE"); },
  get EMPLOYEE() { return t("enums.docKind.EMPLOYEE"); },
  get LICENSE() { return t("enums.docKind.LICENSE"); },
};

export const APPROVAL_KIND: Record<string, { label: string; tone: Tone }> = {
  MAINTENANCE_APPROVAL: { get label() { return t("enums.approvalKind.MAINTENANCE_APPROVAL"); }, tone: "amber" },
  QUOTE_APPROVAL: { get label() { return t("enums.approvalKind.QUOTE_APPROVAL"); }, tone: "violet" },
  MAINTENANCE_HANDOVER: { get label() { return t("enums.approvalKind.MAINTENANCE_HANDOVER"); }, tone: "blue" },
  INVOICE_REVIEW: { get label() { return t("enums.approvalKind.INVOICE_REVIEW"); }, tone: "violet" },
  INVOICE_TRANSFER: { get label() { return t("enums.approvalKind.INVOICE_TRANSFER"); }, tone: "green" },
  EXPENSE_APPROVAL: { get label() { return t("enums.approvalKind.EXPENSE_APPROVAL"); }, tone: "amber" },
  HANDOVER_REVIEW: { get label() { return t("enums.approvalKind.HANDOVER_REVIEW"); }, tone: "blue" },
};

export const FIELD_LABEL: Record<string, string> = {
  get plateNumber() { return t("labels.fieldLabel.plateNumber"); },
  get vehicleNumber() { return t("labels.fieldLabel.vehicleNumber"); },
  get make() { return t("labels.fieldLabel.make"); },
  get model() { return t("labels.fieldLabel.model"); },
  get year() { return t("labels.fieldLabel.year"); },
  get color() { return t("labels.fieldLabel.color"); },
  get vin() { return t("labels.fieldLabel.vin"); },
  get currentOdometer() { return t("labels.fieldLabel.currentOdometer"); },
  get status() { return t("labels.fieldLabel.status"); },
  get projectId() { return t("labels.fieldLabel.projectId"); },
  get purchaseDate() { return t("labels.fieldLabel.purchaseDate"); },
  get purchasePrice() { return t("labels.fieldLabel.purchasePrice"); },
  get warrantyStart() { return t("labels.fieldLabel.warrantyStart"); },
  get warrantyEnd() { return t("labels.fieldLabel.warrantyEnd"); },
  get notes() { return t("labels.fieldLabel.notes"); },
  get name() { return t("labels.fieldLabel.name"); },
  get description() { return t("labels.fieldLabel.description"); },
  get budget() { return t("labels.fieldLabel.budget"); },
  get managerId() { return t("labels.fieldLabel.managerId"); },
  get startDate() { return t("labels.fieldLabel.startDate"); },
  get endDate() { return t("labels.fieldLabel.endDate"); },
  get code() { return t("labels.fieldLabel.code"); },
  get phone() { return t("labels.fieldLabel.phone"); },
  get plateArabic() { return t("labels.fieldLabel.plateArabic"); },
  get plateEnglish() { return t("labels.fieldLabel.plateEnglish"); },
  get serialNumber() { return t("labels.fieldLabel.serialNumber"); },
  get contractValue() { return t("labels.fieldLabel.contractValue"); },
  get taxNumber() { return t("labels.fieldLabel.taxNumber"); },
  get address() { return t("labels.fieldLabel.address"); },
  get severity() { return t("labels.fieldLabel.severity"); },
  get responsibility() { return t("labels.fieldLabel.responsibility"); },
  get repairCost() { return t("labels.fieldLabel.repairCost"); },
  get insuranceClaimNumber() { return t("labels.fieldLabel.insuranceClaimNumber"); },
  get amount() { return t("labels.fieldLabel.amount"); },
  get title() { return t("common.address"); },
  get priority() { return t("labels.fieldLabel.priority"); },
  get dueDate() { return t("labels.fieldLabel.dueDate"); },
};

export function labelOf(map: LabelMap, key: string) {
  return map[key] ?? { label: key, tone: "gray" as Tone };
}
