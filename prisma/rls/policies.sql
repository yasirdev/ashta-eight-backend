-- Ashta Eight — Row-Level Security policies (Architect / Agent 0)
-- Applied as a SQL migration AFTER `prisma migrate` (Prisma does not manage RLS).
-- Deny-by-default: RLS is enabled + FORCED on every table; a row is visible only
-- if a policy below explicitly permits it.
--
-- TWO DATABASE ROLES (created in migration 000_roles, not here):
--   ashta_app     — NOSUPERUSER, NO BYPASSRLS. Handles ALL authenticated member/
--                   admin requests. Backend runs per request:
--                       SET LOCAL app.user_id  = '<uuid>';
--                       SET LOCAL app.user_role = '<role>';
--                   Every policy below is evaluated against this session context.
--   ashta_service — BYPASSRLS. Used ONLY for legitimately cross-ownership system
--                   flows: registration/login, token issuance + verification,
--                   Stripe webhook activation, FCM send-logging, anonymous
--                   questionnaire capture, and cron sweeps (renewal reminders).
--                   Narrow, audited surface — never used for member-supplied reads.
--
-- The API layer adds authorization ON TOP of these policies; RLS is the floor,
-- not the ceiling. Never trust the client for identity/role/tier.

-- ─────────────────────────────────────────────────────────────────────────────
-- Session-context helpers (schema `app`)
-- current_user_id / current_role / is_staff read only the session GUCs (no table
-- access) → plain STABLE. current_tier_rank reads subscriptions+programmes, so it
-- is SECURITY DEFINER owned by ashta_service (BYPASSRLS) to evaluate tier
-- regardless of the caller's own RLS — see its comment for why that matters.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS app;

-- ─────────────────────────────────────────────────────────────────────────────
-- RE-RUNNABLE BY CONSTRUCTION (added 2026-07-23, Agent 1, with the G-4/G-5 tables).
-- This file is the COMPLETE set of policies, so it drops every existing one in
-- `public` before recreating them. Without this, `npm run db:rls` succeeds only on a
-- fresh database: on an existing one it dies at the first CREATE POLICY with "policy
-- already exists" — and the `GRANT ... ON ALL TABLES IN SCHEMA public` at the bottom,
-- which is evaluated when it runs rather than prospectively, therefore never reaches a
-- newly migrated table. That is the exact operational hazard ARCH_SPEC_G1 §1 named, and
-- ARCH_SPEC_G4_G8 §1.7/§2.4 both instruct that this script be re-run for the two new
-- tables — an instruction that was not executable until now.
--
-- Two safety properties: the whole file runs in ONE transaction (BEGIN below,
-- COMMIT at the end), so a mid-file failure rolls back to the previous policy set
-- rather than leaving a half-policied database; and the intermediate state is
-- fail-CLOSED anyway, since a table with RLS enabled and no policy denies every row.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_role', true), '')
$$;

-- R1: only administrator is staff. Coach/content_manager/pa are listed now so
-- R2 slots in with zero policy changes.
CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_role() IN ('administrator', 'coach', 'content_manager', 'pa')
$$;

-- Member's effective tier rank = highest tier_rank among ACTIVE, unexpired
-- subscriptions. 0 (free/preview) when none. DB-authoritative — never passed by
-- the client. SECURITY DEFINER (owned by ashta_service, BYPASSRLS) so the
-- subscriptions/programmes reads bypass the CALLER's RLS. Without this, the
-- programmes RLS (is_active OR is_staff) would drop a programme the admin has
-- deactivated (D1 anticipates re-pricing via is_active=false), silently
-- collapsing an active paying member's tier to 0 and revoking their content.
-- Safe: the WHERE clause scopes the sum to the caller's own user_id (session GUC),
-- and search_path is pinned so the definer context can't be hijacked.
CREATE OR REPLACE FUNCTION app.current_tier_rank() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(MAX(p.tier_rank), 0)
  FROM subscriptions s
  JOIN programmes p ON p.id = s.programme_id
  WHERE s.user_id = app.current_user_id()
    AND s.status = 'active'
    AND (s.current_period_end IS NULL OR s.current_period_end > now())
$$;
-- Own it by the BYPASSRLS service role (least privilege — not the superuser owner).
ALTER FUNCTION app.current_tier_rank() OWNER TO ashta_service;

-- has_active_trial (CR-001): true iff the caller has an ACTIVE 15-day free trial.
-- Reads users.trial_started_at for the current user only. SECURITY DEFINER (owned by
-- ashta_service, BYPASSRLS) for the same reason as current_tier_rank — it must not be
-- re-filtered by the caller's own RLS, and it is called from inside content_select.
-- The 15-day window is expressed here so the trial expires by construction: once
-- trial_started_at is older than 15 days the free set silently drops, no cron needed.
CREATE OR REPLACE FUNCTION app.has_active_trial() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = app.current_user_id()
      AND u.trial_started_at IS NOT NULL
      AND u.trial_started_at > now() - interval '15 days'
  )
$$;
ALTER FUNCTION app.has_active_trial() OWNER TO ashta_service;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper to reduce boilerplate: enable + FORCE RLS on a table.
-- ─────────────────────────────────────────────────────────────────────────────
-- (Inlined below per-table; FORCE ensures even the table owner is constrained.)

-- ═════════════════════════════════════════════════════════════════════════════
-- IDENTITY & AUTH
-- ═════════════════════════════════════════════════════════════════════════════

-- users: self read/update; staff read all. Inserts (registration) via service role.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT
  USING (id = app.current_user_id() OR app.is_staff());
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app.current_user_id() OR app.is_staff())
  WITH CHECK (id = app.current_user_id() OR app.is_staff());
CREATE POLICY users_delete ON users FOR DELETE
  USING (app.is_staff());
-- NOTE: RLS cannot block a member from changing their OWN `role` column.
-- Role immutability for self-updates is enforced by (a) the API never accepting
-- role in a profile update and (b) a BEFORE UPDATE trigger — see §trigger below.

-- auth_identities / refresh_tokens / verification_tokens: NO app-role policy →
-- fully denied to members and admins. Touched only by ashta_service (BYPASSRLS).
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_tokens FORCE ROW LEVEL SECURITY;

-- two_factor_secrets: auth-secret table. Denied to app role; service role only.
ALTER TABLE two_factor_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE two_factor_secrets FORCE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- PROGRAMMES / SUBSCRIPTIONS / BILLING
-- ═════════════════════════════════════════════════════════════════════════════

-- programmes: public catalogue (active rows readable by anyone incl. anon app
-- role); staff manage.
ALTER TABLE programmes ENABLE ROW LEVEL SECURITY;
ALTER TABLE programmes FORCE ROW LEVEL SECURITY;
CREATE POLICY programmes_select ON programmes FOR SELECT
  USING (is_active OR app.is_staff());
CREATE POLICY programmes_write ON programmes FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- subscriptions: member reads own; staff read/write all. Row creation/mutation
-- happens via webhook (service) or admin (staff); members never insert directly.
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY subscriptions_write ON subscriptions FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- billing_records: member reads own; staff read/write (refunds). Webhook writes
-- via service role.
ALTER TABLE billing_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_records FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_select ON billing_records FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY billing_write ON billing_records FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- webhook_events: staff read (debugging); writes via service role only.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_events_select ON webhook_events FOR SELECT
  USING (app.is_staff());

-- ═════════════════════════════════════════════════════════════════════════════
-- CONTENT & PROGRESS
-- ═════════════════════════════════════════════════════════════════════════════

-- content: THE tier gate. Members see only published content at/below their
-- active tier rank; staff see everything incl. drafts.
ALTER TABLE content ENABLE ROW LEVEL SECURITY;
ALTER TABLE content FORCE ROW LEVEL SECURITY;
CREATE POLICY content_select ON content FOR SELECT
  USING (
    app.is_staff()
    OR (
      published_at IS NOT NULL
      AND published_at <= now()
      AND required_tier_rank <= app.current_tier_rank()
    )
    -- CR-001 free set: a member with an ACTIVE 15-day trial sees PUBLISHED
    -- free_preview rows regardless of tier. `published_at` still applies (a draft
    -- is never exposed), and this branch grants ONLY free_preview rows — a paid,
    -- non-free row stays behind the tier gate above. When the trial expires
    -- (has_active_trial() → false) this branch stops matching, so the free set
    -- drops on its own. free_preview defaults false, so nothing leaks by accident.
    OR (
      published_at IS NOT NULL
      AND published_at <= now()
      AND free_preview
      AND app.has_active_trial()
    )
  );
CREATE POLICY content_write ON content FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- content_progress: member owns own rows; staff read (client profile view).
ALTER TABLE content_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY content_progress_select ON content_progress FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY content_progress_insert ON content_progress FOR INSERT
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY content_progress_update ON content_progress FOR UPDATE
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY content_progress_delete ON content_progress FOR DELETE
  USING (user_id = app.current_user_id());

-- content_completions: append-only session history. Same ownership model as
-- content_progress — but note what is NOT here: no UPDATE policy and no DELETE
-- policy. With RLS ENABLE + FORCE and deny-by-default, their ABSENCE is the
-- append-only enforcement: the app role holds table-level UPDATE/DELETE grants,
-- and zero rows satisfy a policy that does not exist. Immutability is therefore a
-- property of the database, not a convention the API is trusted to keep.
-- Corrections (support, GDPR erasure) are a service-role/DBA operation, audited.
-- Staff get SELECT (the admin client profile already surfaces a progress summary)
-- and no write. GDPR erasure of a member is covered by ON DELETE CASCADE from users.
ALTER TABLE content_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_completions FORCE  ROW LEVEL SECURITY;
CREATE POLICY content_completions_select ON content_completions FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY content_completions_insert ON content_completions FOR INSERT
  WITH CHECK (user_id = app.current_user_id());

-- content_categories: a public-ish browse taxonomy, same posture as `programmes`
-- (active rows readable by any app-role session; staff manage). The tiles carry no
-- member data — the tier gate stays on `content` itself, which every category
-- listing reads THROUGH, so a category can never reveal that above-tier content exists.
ALTER TABLE content_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_categories FORCE  ROW LEVEL SECURITY;
CREATE POLICY content_categories_select ON content_categories FOR SELECT
  USING (is_active OR app.is_staff());
CREATE POLICY content_categories_write ON content_categories FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- info_pages / faqs (CR-008): public-ish, same posture as `programmes` — published rows
-- readable by any app-role session (incl. anon signup-consent), staff manage. They carry
-- no member data, so a leaked draft is the only risk and `is_published` covers it.
ALTER TABLE info_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE info_pages FORCE  ROW LEVEL SECURITY;
CREATE POLICY info_pages_select ON info_pages FOR SELECT
  USING (is_published OR app.is_staff());
CREATE POLICY info_pages_write ON info_pages FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE faqs FORCE  ROW LEVEL SECURITY;
CREATE POLICY faqs_select ON faqs FOR SELECT
  USING (is_published OR app.is_staff());
CREATE POLICY faqs_write ON faqs FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- progress_entries: same ownership model.
ALTER TABLE progress_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY progress_entries_select ON progress_entries FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY progress_entries_insert ON progress_entries FOR INSERT
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY progress_entries_update ON progress_entries FOR UPDATE
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY progress_entries_delete ON progress_entries FOR DELETE
  USING (user_id = app.current_user_id());

-- ═════════════════════════════════════════════════════════════════════════════
-- BOOKINGS
-- ═════════════════════════════════════════════════════════════════════════════

-- coaching_slots: members browse OPEN slots; owner/staff manage.
ALTER TABLE coaching_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY coaching_slots_select ON coaching_slots FOR SELECT
  USING (app.is_staff() OR owner_id = app.current_user_id() OR status = 'open');
CREATE POLICY coaching_slots_write ON coaching_slots FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- bookings: member owns own; staff full. Member may cancel own (update).
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY bookings_select ON bookings FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY bookings_insert ON bookings FOR INSERT
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY bookings_update ON bookings FOR UPDATE
  USING (user_id = app.current_user_id() OR app.is_staff())
  WITH CHECK (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY bookings_delete ON bookings FOR DELETE
  USING (app.is_staff());

-- live_cohort_sessions: a member sees sessions for a batch they're actively
-- enrolled in (active subscription with matching cohort_batch); staff manage all.
ALTER TABLE live_cohort_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_cohort_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY live_cohort_select ON live_cohort_sessions FOR SELECT
  USING (
    app.is_staff()
    OR EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.user_id = app.current_user_id()
        AND s.cohort_batch = live_cohort_sessions.batch
        AND s.status = 'active'
        AND (s.current_period_end IS NULL OR s.current_period_end > now())
    )
  );
CREATE POLICY live_cohort_write ON live_cohort_sessions FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- ═════════════════════════════════════════════════════════════════════════════
-- COACHING LEADS (admin pipeline — contains admin-private `notes`)
-- ═════════════════════════════════════════════════════════════════════════════

-- Staff-only. Members do NOT read their own lead row (it carries private notes).
-- Website application-form inserts arrive via service role.
ALTER TABLE coaching_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY coaching_leads_staff ON coaching_leads FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- ═════════════════════════════════════════════════════════════════════════════
-- NOTIFICATIONS
-- ═════════════════════════════════════════════════════════════════════════════

-- device_tokens: member owns own (register/refresh/remove).
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY device_tokens_select ON device_tokens FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY device_tokens_insert ON device_tokens FOR INSERT
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY device_tokens_update ON device_tokens FOR UPDATE
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
CREATE POLICY device_tokens_delete ON device_tokens FOR DELETE
  USING (user_id = app.current_user_id());

-- notifications: member reads own + marks read; sends are logged via service role.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

-- ═════════════════════════════════════════════════════════════════════════════
-- RECOMMENDATION REQUESTS
-- ═════════════════════════════════════════════════════════════════════════════

-- Member reads own; staff read (analytics). Anonymous capture + engine writes
-- go through service role (anon rows have no user_id yet).
ALTER TABLE recommendation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY recommendation_select ON recommendation_requests FOR SELECT
  USING (user_id = app.current_user_id() OR app.is_staff());

-- ═════════════════════════════════════════════════════════════════════════════
-- MULTILINGUAL FOUNDATION (CR-003) — locales + translations
-- ═════════════════════════════════════════════════════════════════════════════

-- locales: reference set. Active rows are readable by any app-role session (the app
-- needs to know which languages exist and their RTL flag); staff manage. Same posture
-- as `programmes` / `content_categories`. R1 seeds all 20; only `en` is active.
ALTER TABLE locales ENABLE ROW LEVEL SECURITY;
ALTER TABLE locales FORCE  ROW LEVEL SECURITY;
CREATE POLICY locales_select ON locales FOR SELECT
  USING (is_active OR app.is_staff());
CREATE POLICY locales_write ON locales FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- translations: read MIRRORS the parent entity's visibility — a member may read a
-- translation ONLY for a row they can already see. The EXISTS subqueries below are NOT
-- SECURITY DEFINER, so they run under the caller's OWN RLS: the parent table's SELECT
-- policy is applied inside each branch for free (content_select gates the content branch,
-- programmes_select the programme branch, content_categories_select the category branch).
-- A tier-gated content row's translation is therefore unreachable by exactly the same
-- rule that hides the row itself — no second copy of the tier logic to drift.
--
-- Fail-CLOSED for an unknown entity_type: only staff read it. Adding a NEW localizable
-- entity in R2 REQUIRES adding a branch here — the safe direction. Staff read everything
-- (they author translations) and are the only writers.
--
-- entity_id is uuid, matching every localizable R1 entity's PK. EMPTY in R1, so this
-- policy is first exercised in R2 — but it is correct now.
ALTER TABLE translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE translations FORCE  ROW LEVEL SECURITY;
CREATE POLICY translations_select ON translations FOR SELECT
  USING (
    app.is_staff()
    OR (entity_type = 'content'          AND EXISTS (SELECT 1 FROM content            c  WHERE c.id  = entity_id))
    OR (entity_type = 'programme'        AND EXISTS (SELECT 1 FROM programmes         p  WHERE p.id  = entity_id))
    OR (entity_type = 'content_category' AND EXISTS (SELECT 1 FROM content_categories cc WHERE cc.id = entity_id))
  );
CREATE POLICY translations_write ON translations FOR ALL
  USING (app.is_staff()) WITH CHECK (app.is_staff());

-- ═════════════════════════════════════════════════════════════════════════════
-- COMMUNITY (R2 — locked until R2; NO app-role policy = fully denied)
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE community_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE community_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_comments FORCE ROW LEVEL SECURITY;
ALTER TABLE community_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_reactions FORCE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- §trigger — self-update guard on users (belt to the RLS suspenders)
-- Stops a non-staff session from changing privileged columns even if the API
-- layer regresses: `role` (escalation) and `notes` (admin-private client notes).
-- Column-level REVOKE can't do this — the app role's table-level UPDATE grant
-- overrides it — so, like role, notes is frozen here + never accepted by /me.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION app.prevent_self_role_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app.is_staff() THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'role change not permitted for non-staff session';
    END IF;
    IF NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'notes change not permitted for non-staff session';
    END IF;
    -- plan_started_at is the 8-week map anchor (G-6). It is written ONCE by the
    -- Stripe webhook on the service role; a member rewinding it would hand
    -- themselves week 1 forever. Frozen here for the same reason as `role` and
    -- `notes`: so it holds even if PATCH /me ever regresses and accepts the field.
    IF NEW.plan_started_at IS DISTINCT FROM OLD.plan_started_at THEN
      RAISE EXCEPTION 'plan_started_at change not permitted for non-staff session';
    END IF;
    -- trial_started_at (CR-001) is an entitlement grant: it opens the free content
    -- set for 15 days. A member self-setting or rewinding it would grant/extend their
    -- own trial. Written ONCE by POST /me/trial on the service role; frozen here so it
    -- holds even if PATCH /me ever regresses and accepts the field.
    IF NEW.trial_started_at IS DISTINCT FROM OLD.trial_started_at THEN
      RAISE EXCEPTION 'trial_started_at change not permitted for non-staff session';
    END IF;
    -- deleted_at (soft-delete) is written ONLY by DELETE /me on the service role. A
    -- member setting/clearing it via PATCH /me could self-delete oddly or un-delete;
    -- frozen here so the delete endpoint is the sole controlled path.
    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'deleted_at change not permitted for non-staff session';
    END IF;
    -- disabled_at (admin disable) is written ONLY by an admin action on the service
    -- role. A member self-clearing it would re-enable their own blocked account.
    IF NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
      RAISE EXCEPTION 'disabled_at change not permitted for non-staff session';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_users_prevent_role_change ON users;
CREATE TRIGGER trg_users_prevent_role_change
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.prevent_self_role_change();

-- ═════════════════════════════════════════════════════════════════════════════
-- GRANTS (least-privilege for the app role; service role owns tables / bypasses)
-- ═════════════════════════════════════════════════════════════════════════════
-- Both roles need USAGE on `app`: ashta_app calls the helpers directly, and
-- ashta_service is the DEFINER owner of current_tier_rank() (which resolves
-- app.current_user_id() inside its body).
GRANT USAGE ON SCHEMA app TO ashta_app, ashta_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ashta_app;
-- ashta_service is BYPASSRLS, which bypasses POLICIES — not table privileges. It
-- therefore needs this grant too, and `ALL TABLES` is evaluated when the statement runs,
-- so a table added by a later migration is NOT covered retroactively.
-- Deliberately duplicated from 000_roles.sql:23 (an idempotent GRANT, so re-running both
-- is harmless): 000_roles.sql is documented "run ONCE", while THIS file is the one the
-- specs tell you to re-run after a migration adds a table. Without the line here,
-- `npm run db:rls` alone left content_completions/content_categories readable by the app
-- role and PERMISSION DENIED to the service role — found by the QA suite, 2026-07-23.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ashta_service;
-- Auth-secret tables carry no app-role policy, so RLS denies all rows; revoke
-- table privileges too for defence in depth.
REVOKE ALL ON auth_identities, refresh_tokens, verification_tokens, two_factor_secrets FROM ashta_app;
-- Prisma's migration bookkeeping table is not part of the runtime surface for
-- either role (migrations run as the owner). Revoke the blanket ALL-TABLES grant.
REVOKE ALL ON _prisma_migrations FROM ashta_app, ashta_service;
-- users.notes is ADMIN-PRIVATE. A non-staff self-update can't change it (frozen by
-- the §trigger guard below, same posture as `role`); staff/service write it via the
-- admin client-notes endpoint. No member endpoint exposes notes in its response.

-- Closes the transaction opened at the top (see "RE-RUNNABLE BY CONSTRUCTION").
COMMIT;
