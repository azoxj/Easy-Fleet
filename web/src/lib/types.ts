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

export type VehicleDetail = Vehicle & { capabilities: { update: boolean; archive: boolean } };

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
