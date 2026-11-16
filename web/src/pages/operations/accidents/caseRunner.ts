import { useState } from "react";
import { useToast } from "../../../components/feedback";
import { t } from "../../../i18n";
import { apiUpload } from "../../../lib/api";
import { missingFromError } from "../../../lib/accidentWorkflow";
import { errorMessage } from "../../../lib/forms";

/**
 * Runs the actions of the case screen: busy flag, success toast, error toast, and the server's list of missing items when it
 * refuses a step (409 REQUIREMENTS_NOT_MET). The screen never decides a step is allowed: it asks, and shows the answer.
 */
export function useCaseRunner(reload: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(key);
    setMissing(null);
    try {
      await fn();
      toast.success(success);
      reload();
      return true;
    } catch (err) {
      const m = missingFromError(err);
      if (m) setMissing(m);
      else toast.error(errorMessage(err));
      // The screen may be out of date (another user moved the case): show the current state.
      if ((err as { status?: number }).status === 409) reload();
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, missing, clearMissing: () => setMissing(null), run };
}

export const uploadToCase = (caseId: string, category: string, file: File) => apiUpload(`/accident-cases/${caseId}/attachments?category=${category}`, file, fetch, "POST");

/** Message for a file that was chosen but is not an allowed type or is too large, before anything is sent. */
export function fileProblem(file: File, maxMb = 10): string | null {
  if (!/^(application\/pdf|image\/(png|jpeg|webp))$/.test(file.type)) return t("accidentFlow.doc.badType");
  if (file.size > maxMb * 1024 * 1024) return t("accidentFlow.doc.tooLarge", { mb: maxMb });
  return null;
}
