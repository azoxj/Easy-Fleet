import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AppLayout } from "./components/layout/AppLayout";
import { Loading } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { AssignmentsPage, MyAssignmentsPage } from "./pages/AssignmentsPages";
import { AuditLogPage } from "./pages/AuditLogPage";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { ProjectDetailPage } from "./pages/projects/ProjectDetailPage";
import { ProjectsPage } from "./pages/projects/ProjectsPage";
import { RolesPage } from "./pages/RolesPage";
import { UsersPage } from "./pages/users/UsersPage";
import { VehicleDetailPage } from "./pages/vehicles/VehicleDetailPage";
import { VehiclesPage } from "./pages/vehicles/VehiclesPage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (me.mustChangePassword && location.pathname !== "/change-password") return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** Hides routes the user cannot use. The API enforces the same rule server-side. */
function Gate({ perm, anyOf, children }: { perm?: string; anyOf?: string[]; children: ReactNode }) {
  const { can } = useAuth();
  const ok = perm ? can(perm) : anyOf ? anyOf.some((p) => can(p)) : true;
  return ok ? <>{children}</> : <NotFoundPage />;
}

function Home() {
  const { can } = useAuth();
  return can("dashboard.view") ? <DashboardPage /> : <Navigate to="/my-assignments" replace />;
}

function ChangePasswordRoute() {
  const { me } = useAuth();
  // Forced change renders full-screen; voluntary change renders inside the app shell.
  return me?.mustChangePassword ? <ChangePasswordPage /> : <Navigate to="/account/password" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<RequireAuth><ChangePasswordRoute /></RequireAuth>} />
          <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
            <Route index element={<Home />} />
            <Route path="account/password" element={<ChangePasswordPage />} />
            <Route path="my-assignments" element={<MyAssignmentsPage />} />
            <Route path="assignments" element={<Gate anyOf={["assignments.read", "assignments.create"]}><AssignmentsPage /></Gate>} />
            <Route path="projects" element={<Gate perm="projects.read"><ProjectsPage /></Gate>} />
            <Route path="projects/:id" element={<Gate perm="projects.read"><ProjectDetailPage /></Gate>} />
            <Route path="vehicles" element={<Gate perm="vehicles.read"><VehiclesPage /></Gate>} />
            <Route path="vehicles/:id" element={<Gate perm="vehicles.read"><VehicleDetailPage /></Gate>} />
            <Route path="users" element={<Gate perm="users.read"><UsersPage /></Gate>} />
            <Route path="roles" element={<Gate perm="roles.read"><RolesPage /></Gate>} />
            <Route path="audit" element={<Gate perm="audit.read"><AuditLogPage /></Gate>} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
