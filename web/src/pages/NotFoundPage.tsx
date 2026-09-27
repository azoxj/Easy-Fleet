import { Link } from "react-router";
import { EmptyState } from "../components/ui";
import { t } from "../i18n";

export function NotFoundPage() {
  return (
    <EmptyState
      icon="search"
      title={t("notFound.pageNotFound")}
      description={t("notFound.thePageMayHaveMoved")}
      action={<Link to="/" className="text-sm font-medium text-brand-700 hover:underline">{t("notFound.backToHome")}</Link>}
    />
  );
}
