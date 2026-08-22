-- Account soft-delete (ACTION_ITEMS 2026-07-27): users.deleted_at.
--
-- Set by DELETE /me (service role), which also revokes the account's sessions; a
-- soft-deleted account cannot log in (guarded in /auth/login + OAuth + 2FA). Data is
-- RETAINED (soft) — GDPR hard-erasure is a separate later sweep. Member-immutable
-- (frozen by app.prevent_self_role_change()) so it is only written via the delete
-- endpoint. No RLS policy change (a column on users inherits users_select/update).
-- After deploy, re-run `npm run db:rls` (the trigger guard is (re)created there).
--
-- Rollback: ALTER TABLE "users" DROP COLUMN "deleted_at";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6);
