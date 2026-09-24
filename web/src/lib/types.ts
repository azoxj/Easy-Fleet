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
  managerId: string | null;
  managerName: string | null;
  vehicleCount: number;
  memberCount: number;
  createdAt: string;
};

export type ProjectDetail = Project & {
  vehicleStats: Record<string, number>;
  capabilities: { update: boolean; updateSensitive: boolean; manageMembers: boolean };
};

export type Vehicle = {
  id: string;
  plateNumber: string;
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
