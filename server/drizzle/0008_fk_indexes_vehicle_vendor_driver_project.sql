-- Indexes for foreign keys that real screens filter by (Vehicle 360 invoices, vendor invoices, driver accidents/fuel,
-- project-scoped handover lists). Additive only: no table or column changes; IF NOT EXISTS makes it re-runnable.
CREATE INDEX IF NOT EXISTS "invoices_vehicle_idx" ON "invoices" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_vendor_idx" ON "invoices" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accidents_driver_idx" ON "accidents" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fuel_driver_idx" ON "fuel_transactions" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handover_project_idx" ON "handover_sessions" USING btree ("project_id");