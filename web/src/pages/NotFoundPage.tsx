import { Link } from "react-router";
import { EmptyState } from "../components/ui";

export function NotFoundPage() {
  return (
    <EmptyState
      icon="search"
      title="الصفحة غير موجودة"
      description="ربما تم نقل الصفحة أو ليست لديك صلاحية الوصول إليها."
      action={<Link to="/" className="text-sm font-medium text-brand-700 hover:underline">العودة للرئيسية</Link>}
    />
  );
}
