import { eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { accidentSettings } from "../../db/schema/index.js";
import { DEFAULT_SLA_DAYS, type SlaDays } from "./workflow.js";

/** The organisation's SLA days (calendar days), or the defaults 3/5/7/3 when nothing was configured. */
export async function loadSla(db: DbOrTx, orgId: string): Promise<SlaDays> {
  const [s] = await db.select().from(accidentSettings).where(eq(accidentSettings.organizationId, orgId));
  return s ? { slaTechnicalDays: s.slaTechnicalDays, slaEstimatesDays: s.slaEstimatesDays, slaInsuranceDays: s.slaInsuranceDays, slaClosureDays: s.slaClosureDays } : { ...DEFAULT_SLA_DAYS };
}
