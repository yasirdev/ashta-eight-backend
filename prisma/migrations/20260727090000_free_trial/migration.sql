-- CR-001 (free/guest tier: 15-day trial + admin-configurable free content set),
-- authorized 2026-07-27; contracts §7.
--
--   * users.trial_started_at  — the trial anchor. Set ONCE by POST /me/trial
--                               (service role); active while now() < it + 15 days.
--                               One-per-account (activation only sets when NULL);
--                               member-immutable (§trigger guard). NULL = never trialed.
--   * content.free_preview    — the admin-configurable "free set". A member with an
--                               ACTIVE trial sees published free_preview rows regardless
--                               of tier (RLS content_select). Default false.
--
-- This changes the content-access RLS (content_select) — the security-critical tier
-- gate — so it MUST pass the Agent 7 gate + human security review (§5.6). After deploy,
-- `npm run db:rls` MUST run (the content_select policy + the new app.has_active_trial()
-- helper are (re)created there, not by this migration).
--
-- Rollback:
--   ALTER TABLE "content" DROP COLUMN "free_preview";
--   ALTER TABLE "users" DROP COLUMN "trial_started_at";
--   -- then re-run db:rls to restore the tier-only content_select.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "trial_started_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "content" ADD COLUMN     "free_preview" BOOLEAN NOT NULL DEFAULT false;
