-- Admin client controls (ACTION_ITEMS 2026-07-27): users.disabled_at.
--
-- Set by an admin (service role) to block a client's login WITHOUT deleting them
-- (reversible via enable). Distinct from deleted_at (soft-delete). Both revoke the
-- client's sessions and block login (403 account_disabled / account_deleted).
-- Member-immutable (frozen by app.prevent_self_role_change()). No RLS policy change
-- (a column on users). Re-run `npm run db:rls` after deploy (trigger is recreated there).
--
-- Rollback: ALTER TABLE "users" DROP COLUMN "disabled_at";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabled_at" TIMESTAMPTZ(6);
