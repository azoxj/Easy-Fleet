import { sql } from "drizzle-orm";
import { accidents } from "../../db/schema/index.js";

/** Drafts are not accidents yet for statistics: excluded from open counts, KPIs, charts and reports. */
export const notDraft = sql`${accidents.workflowStage} is distinct from 'DRAFT'`;

/** The "returned for completion" marker is active while the case is still in the stage it was sent back to. */
export const returnedMarker = sql`(${accidents.returnedAt} is not null and ${accidents.returnedToStage} = ${accidents.workflowStage})`;
