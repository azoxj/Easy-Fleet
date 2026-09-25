import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";
import { Alert, Loading } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage } from "../lib/forms";

/** /q/<token>: resolves a scanned vehicle QR inside the caller's scope. */
export function QrResolvePage() {
  const { token } = useParams();
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ data: { id: string } }>(`/qr/${encodeURIComponent(token ?? "")}`).then((r) => setTarget(r.data.id)).catch((e) => setError(errorMessage(e, "المركبة غير موجودة أو خارج صلاحياتك")));
  }, [token]);
  if (error) return <Alert>{error}</Alert>;
  if (target) return <Navigate to={`/vehicles/${target}`} replace />;
  return <Loading label="جارٍ فتح المركبة..." />;
}
