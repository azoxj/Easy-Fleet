export type Scope = "ALL" | "PROJECT" | "ASSIGNED";

export type Me = {
  id: string;
  email: string;
  name: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: Record<string, Scope>;
  projectIds: string[];
  csrfToken: string;
};

export type Project = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  budget: string | null;
  contractValue?: string | null;
  managerId: string | null;
  managerName: string | null;
  vehicleCount: number;
  memberCount: number;
  createdAt: string;
};

export type ProjectDetail = Project & {
  vehicleStats: Record<string, number>;
  capabilities: { update: boolean; updateSensitive: boolean; manageMembers: boolean; removeMembers?: boolean; archive?: boolean; financials?: boolean };
};

export type Vehicle = {
  id: string;
  plateNumber: string;
  plateArabic?: string | null;
  plateEnglish?: string | null;
  serialNumber?: string | null;
  vehicleNumber: string | null;
  make: string;
  model: string;
  year: number | null;
  color: string | null;
  vin: string | null;
  currentOdometer: number;
  status: string;
  projectId: string | null;
  projectName: string | null;
  assignedDriverId: string | null;
  purchaseDate: string | null;
  purchasePrice: string | null;
  warrantyStart: string | null;
  warrantyEnd: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VehicleDetail = Vehicle & {
  currentDriver: { id: string; fullName: string; licenseExpiryDate: string | null } | null;
  capabilities: { update: boolean; archive: boolean; changeDriver: boolean };
};

export type ExpiryStatus = "ACTIVE" | "EXPIRING_SOON" | "EXPIRED";

export type EmployeeRow = {
  id: string;
  employeeNumber: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  jobTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  status: string;
  hireDate: string | null;
  driverId: string | null;
};

export type EmployeeDetail = Omit<EmployeeRow, "driverId"> & {
  nationalIdOrIqama: string | null;
  nationalIdMasked: boolean;
  notes: string | null;
  linkedUser: { id: string; name: string; email: string } | null;
  driver: { id: string; licenseExpiryDate: string | null; status: string; currentVehiclePlate: string | null } | null;
  createdAt: string;
  updatedAt: string;
  capabilities: { update: boolean; archive: boolean; createDriver: boolean };
};

export type DriverRow = {
  id: string;
  employeeId: string;
  fullName: string;
  employeeNumber: string;
  phone: string | null;
  projectId: string | null;
  projectName: string | null;
  licenseNumber: string | null;
  licenseType: string | null;
  licenseIssueDate: string | null;
  licenseExpiryDate: string | null;
  licenseStatus: ExpiryStatus | null;
  licenseDaysLeft: number | null;
  status: string;
  storedStatus: string;
  notes: string | null;
  archivedAt: string | null;
  currentVehicleId: string | null;
  currentVehiclePlate: string | null;
};

export type Alert = { level: "warning" | "danger"; message: string; kind?: string };

export type DriverDetail = DriverRow & {
  history: { id: string; vehicleId: string | null; plateNumber: string | null; assignedAt: string; unassignedAt: string | null }[];
  alerts: Alert[];
  capabilities: { update: boolean; archive: boolean };
};

type FileInfo = { fileName: string | null; fileSize: number | null; fileMime: string | null };

export type VehicleDocument = FileInfo & {
  id: string;
  vehicleId: string;
  documentType: string;
  documentNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  issuer: string | null;
  notes: string | null;
  isCurrent: boolean;
  status: ExpiryStatus;
  daysLeft: number | null;
  createdByName: string | null;
  createdAt: string;
};

export type InsurancePolicy = FileInfo & {
  id: string;
  vehicleId: string;
  provider: string;
  policyNumber: string;
  issueDate: string | null;
  expiryDate: string;
  premiumAmount: string | null;
  coverageType: string;
  notes: string | null;
  isCurrent: boolean;
  status: ExpiryStatus;
  daysLeft: number | null;
  createdByName: string | null;
  createdAt: string;
};

export type Compliance = {
  registration: VehicleDocument | null;
  insurance: InsurancePolicy | null;
  driverLicense: { driverId: string; fullName: string; licenseExpiryDate: string | null; licenseStatus: ExpiryStatus | null } | null;
  alerts: Alert[];
};

export type TimelineEvent = {
  id: number;
  action: string;
  entity: string;
  entityLabel: string;
  actor: string;
  timestamp: string;
  description: string;
};

export type UserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: "ACTIVE" | "DISABLED";
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { key: string; nameAr: string }[];
};

export type Assignment = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  dueDate: string | null;
  projectId: string | null;
  projectName: string | null;
  vehicleId: string | null;
  vehiclePlate: string | null;
  assignedTo: string;
  assignedToName: string;
  assignedBy: string;
  assignedByName: string;
  createdAt: string;
  completedAt: string | null;
};

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export type AuditRow = {
  id: number;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  userName: string | null;
};

export type MaintenanceRow = {
  id: string;
  number: number;
  issue: string;
  priority: string;
  status: string;
  odometer: number | null;
  vehicleId: string;
  plateNumber: string;
  projectId: string | null;
  projectName: string | null;
  assignedTo: string | null;
  technicianName: string | null;
  requestedBy: string;
  requestedByName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cost: string | null;
};

export type MaintenancePart = { id: string; partName: string; partNumber: string | null; quantity: string; unitPrice: string; total: string; vendorId: string | null; vendorName: string | null; notes: string | null };
export type MaintenanceLaborItem = { id: string; description: string; hours: string; hourlyRate: string; total: string };
export type MaintenanceQuote = {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  quoteNumber: string | null;
  amount: string;
  validUntil: string | null;
  notes: string | null;
  status: string;
  reviewReason: string | null;
  createdByName: string;
  fileName: string | null;
  createdAt: string;
};
export type MaintenanceAttachment = { id: string; category: string; fileName: string; fileSize: number; fileMime: string; uploadedByName: string | null; createdAt: string };
export type MaintenanceEvent = { id: number; type: string; fromStatus: string | null; toStatus: string | null; reason: string | null; actor: string | null; createdAt: string };

export type MaintenanceDetail = MaintenanceRow & {
  description: string | null;
  diagnosis: string | null;
  workPerformed: string | null;
  notes: string | null;
  rejectionReason: string | null;
  handoverRejections: number;
  assignedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  closedAt: string | null;
  parts: MaintenancePart[] | null;
  labor: MaintenanceLaborItem[] | null;
  quotes: MaintenanceQuote[] | null;
  attachments: MaintenanceAttachment[];
  timeline: MaintenanceEvent[];
  actions: string[];
  capabilities: {
    edit: Record<string, boolean>;
    manageParts: boolean;
    manageLabor: boolean;
    createQuote: boolean;
    approveQuote: boolean;
    rejectQuote: boolean;
    upload: boolean;
  };
};

export type VehicleMaintenanceSummary = {
  current: { id: string; number: number; status: string; issue: string } | null;
  openCount: number;
  awaitingApproval: number;
  awaitingHandover: number;
  lastMaintenance: { id: string; number: number; issue: string; completedAt: string | null } | null;
  totalCost: string | null;
  nextPlanned: null;
  history: MaintenanceRow[];
};

// ---------------------------------------------------------------- finance / operations
export type Vendor = { id: string; name: string; phone: string | null; email: string | null; taxNumber: string | null; address: string | null; status: string; notes: string | null };

export type InvoiceRow = {
  id: string;
  number: number;
  projectId: string;
  projectName: string;
  vendorId: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  description: string | null;
  amount: string;
  tax: string;
  total: string;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  maintenanceRequestId: string | null;
  vehicleId: string | null;
  plateNumber: string | null;
  createdBy: string;
  createdByName: string;
  hasFile: boolean;
  rejectionReason: string | null;
  overdue: boolean;
  createdAt: string;
};

export type InvoiceDetail = InvoiceRow & {
  fileName: string | null;
  transfer: { transferDate: string; amount: string; bank: string; reference: string; notes: string | null; createdByName: string; createdAt: string } | null;
  timeline: { id: number; action: string; metadata: Record<string, unknown> | null; actor: string | null; createdAt: string }[];
  actions: string[];
};

export type ExpenseRow = {
  id: string;
  projectId: string;
  projectName: string;
  vehicleId: string | null;
  plateNumber: string | null;
  category: string;
  amount: string;
  expenseDate: string;
  vendorName: string | null;
  description: string | null;
  status: string;
  hasReceipt: boolean;
  createdBy: string;
  createdByName: string;
  reviewReason: string | null;
  createdAt: string;
};

export type FuelRow = {
  id: string;
  vehicleId: string;
  plateNumber: string;
  projectId: string | null;
  projectName: string | null;
  driverName: string | null;
  fueledAt: string;
  liters: string;
  pricePerLiter: string;
  total: string;
  station: string | null;
  odometer: number | null;
  hasReceipt: boolean;
  notes: string | null;
  createdBy: string;
  createdByName: string;
};

export type AccidentRow = {
  id: string;
  number: number;
  label: string;
  vehicleId: string;
  plateNumber: string;
  projectId: string | null;
  projectName: string | null;
  driverName: string | null;
  occurredAt: string;
  location: string | null;
  severity: string;
  responsibility: string;
  status: string;
  repairCost: string | null;
  insuranceClaimNumber: string | null;
};

export type ViolationRow = {
  id: string;
  vehicleId: string;
  plateNumber: string;
  projectName: string | null;
  driverName: string | null;
  violationNumber: string | null;
  violationDate: string;
  type: string;
  amount: string;
  authority: string | null;
  status: string;
  paymentDate: string | null;
  disputeReason: string | null;
  hasFile: boolean;
  notes: string | null;
};

export type HandoverRow = {
  id: string;
  vehicleId: string;
  plateNumber: string;
  driverId: string;
  driverName: string | null;
  projectName: string | null;
  status: string;
  expiresAt: string;
  expired: boolean;
  handoverAt: string | null;
  returnAt: string | null;
  handoverOdometer: number | null;
  returnOdometer: number | null;
  createdByName: string;
  createdAt: string;
};
