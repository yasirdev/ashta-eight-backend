-- DESIGN_GAPS G-6 / ARCH_SPEC_G4_G8 §3.2 — the 8-week map anchor.
--
-- Deliberately on `users`, not on `subscriptions`, so an upgrade, a pause or a
-- re-subscribe does not reset the member's journey. Set ONCE by the Stripe webhook on a
-- subscription's first transition to active (COALESCE-guarded, service role), and frozen
-- for non-staff sessions by the §trigger guard in policies.sql.
--
-- NO BACKFILL by design: existing members get it on their next activation. A one-off
-- backfill from the earliest billing_records.occurred_at is possible if the client wants
-- existing members positioned — that is a question to ask, not an assumption to make.
--
-- Rollback: ALTER TABLE "users" DROP COLUMN "plan_started_at";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "plan_started_at" TIMESTAMPTZ(6);
