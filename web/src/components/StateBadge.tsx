import { STATE_META, type MarkerState } from "../lib/fleetMap";
import { Badge } from "./ui";

/** Vehicle GPS state label with a coloured dot — the text carries the meaning, the colour only reinforces it. */
export function StateBadge({ state }: { state: MarkerState }) {
  const m = STATE_META[state];
  return (
    <Badge tone={m.tone}>
      <span className="inline-block size-2 rounded-full" style={{ background: m.color }} aria-hidden="true" />
      {m.label}
    </Badge>
  );
}
