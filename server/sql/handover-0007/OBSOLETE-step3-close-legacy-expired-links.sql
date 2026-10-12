-- OBSOLETE — DO NOT USE IN PRODUCTION.
-- Migration 0007 now closes the legacy expired links by itself, atomically, with a built-in
-- self-check. No SQL has to be run after the deployment. This file only stops anyone who still
-- has the old runbook from running a second, redundant closing step.
DO $$
BEGIN
  RAISE EXCEPTION 'OBSOLETE: Migration 0007 already closes legacy expired handover links. Nothing to run.';
END
$$;
