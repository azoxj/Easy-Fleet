import { useApi } from "../../../hooks/useApi";

/**
 * What the accidents screen may offer. The workflow screens are shown only when the server says the workflow is on
 * (its switch is off by default); while this loads or fails, the screen behaves exactly like the legacy one.
 */
export function useAccidentFeatures() {
  const { data, loading } = useApi<{ data: { workflow: boolean } }>("/accidents/features");
  return { workflow: data?.data.workflow === true, loading };
}
