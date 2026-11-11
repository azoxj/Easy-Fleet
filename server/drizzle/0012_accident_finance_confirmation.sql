ALTER TABLE "accident_claims"
  ADD COLUMN "finance_confirmed_by" uuid,
  ADD COLUMN "finance_confirmed_at" timestamptz,
  ADD COLUMN "finance_confirmation_note" text;

ALTER TABLE "accident_claims"
  ADD CONSTRAINT "accident_claims_finance_confirmed_by_users_id_fk"
  FOREIGN KEY ("finance_confirmed_by")
  REFERENCES "users"("id")
  ON DELETE SET NULL;
