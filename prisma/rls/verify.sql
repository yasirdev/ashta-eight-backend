-- Ashta Eight — RLS verification (the data-layer's one runnable check).
-- Proves deny-by-default, ownership isolation, tier gating, and auth-secret
-- lockdown actually hold. Run AFTER migrate + roles + policies + seed:
--   psql "postgresql://<owner>@localhost:5432/ashta_eight" -v ON_ERROR_STOP=1 -f prisma/rls/verify.sql
-- Exits non-zero on any failed assertion. Wrapped in a txn + ROLLBACK, so it
-- seeds nothing permanent. Run as the migration owner (superuser bypasses RLS
-- for the seed step; the assertions run under SET ROLE ashta_app, which does not).

BEGIN;

-- ── seed throwaway fixtures (as owner; superuser bypasses RLS) ────────────────
-- CR-001: m1 has an ACTIVE free trial (started now); m2 has an EXPIRED one (16 days
-- ago) — so m2 exercises "trial lapsed ⇒ free set drops" as well as "no active trial".
INSERT INTO users (id, email, role, trial_started_at, updated_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'rls-m1@test.local', 'member', now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'rls-m2@test.local', 'member', now() - interval '16 days', now());

-- m1 holds an ACTIVE tier-2 subscription; m2 holds nothing.
INSERT INTO subscriptions (id, user_id, programme_id, status, current_period_end, updated_at)
SELECT '33333333-3333-3333-3333-333333333333',
       '11111111-1111-1111-1111-111111111111', p.id, 'active', now() + interval '30 days', now()
FROM programmes p WHERE p.tier_rank = 2;

-- G-7: the tier-3 row carries artwork, so the "above-tier content is invisible"
-- assertion below doubles as the proof that its thumbnail key is unreachable too —
-- a column on `content` inherits content_select by construction, no policy needed.
INSERT INTO content (id, type, pillar, title, required_tier_rank, published_at, thumbnail_object_key, updated_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'audio', 'align',  'pub tier1', 1, now() - interval '1 day', NULL, now()),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'video', 'evolve', 'pub tier3', 3, now() - interval '1 day',
   'images/00000000-0000-0000-0000-0000000000ff.jpg', now()),
  ('aaaaaaaa-0000-0000-0000-000000000009', 'audio', 'sculpt', 'draft t1',  1, NULL, NULL, now());

-- CR-001 free set: a PUBLISHED tier-3 row flagged free_preview. It is ABOVE m1's tier
-- (2), so ONLY the trial branch of content_select can grant it — isolating that branch.
-- A DRAFT free_preview row proves the free set still respects publication.
INSERT INTO content (id, type, pillar, title, required_tier_rank, published_at, free_preview, updated_at) VALUES
  ('ffffffff-0000-0000-0000-000000000001', 'audio', 'align', 'free set pub', 3, now() - interval '1 day', true, now()),
  ('ffffffff-0000-0000-0000-000000000002', 'audio', 'align', 'free set draft', 3, NULL, true, now());

-- m1 needs an identity row so the auth-secret lockdown test has something to miss.
INSERT INTO auth_identities (id, user_id, provider, provider_subject, password_hash)
VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'password',
        '11111111-1111-1111-1111-111111111111', 'x');

-- G-4: one completion event each for m1 and m2, to prove ownership isolation AND
-- that the append-only property is enforced by the DB rather than by the API.
INSERT INTO content_completions (id, user_id, content_id, duration_seconds, completed_at) VALUES
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', 600, now() - interval '1 hour'),
  ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'aaaaaaaa-0000-0000-0000-000000000001', 600, now() - interval '1 hour');

-- G-5: one active and one inactive browse tile.
INSERT INTO content_categories (id, slug, label, icon_key, type, position, is_active, updated_at) VALUES
  ('dddddddd-0000-0000-0000-000000000001', 'rls-active',   'RLS Active',   'audio', 'audio', 1, true,  now()),
  ('dddddddd-0000-0000-0000-000000000002', 'rls-inactive', 'RLS Inactive', 'audio', 'audio', 2, false, now());

-- CR-003: a translation for a VISIBLE row (tier1) and an INVISIBLE row (tier3), so the
-- `translations_select` "read MIRRORS the parent entity's SELECT" rule is provable BOTH
-- ways. `fr` is a seeded-but-INACTIVE locale (only `en` is active in R1), so the locales
-- active-read rule is provable too. Both rows exist for real in R1 seed data terms only
-- as fixtures here — the shipped seed inserts ZERO translation rows.
INSERT INTO translations (id, entity_type, entity_id, field, locale, value, updated_at) VALUES
  ('eeeeeeee-0000-0000-0000-000000000001', 'content', 'aaaaaaaa-0000-0000-0000-000000000001', 'title', 'fr', 'titre tier1', now()),
  ('eeeeeeee-0000-0000-0000-000000000003', 'content', 'aaaaaaaa-0000-0000-0000-000000000003', 'title', 'fr', 'titre tier3', now());

-- ── assert as ashta_app acting for member m1 ─────────────────────────────────
SET LOCAL ROLE ashta_app;
SELECT set_config('app.user_id',   '11111111-1111-1111-1111-111111111111', true);
SELECT set_config('app.user_role', 'member', true);

DO $$
BEGIN
  -- ownership: sees self, never another member
  ASSERT (SELECT count(*) FROM users WHERE id = '11111111-1111-1111-1111-111111111111') = 1,
    'm1 should see own user row';
  ASSERT (SELECT count(*) FROM users WHERE id = '22222222-2222-2222-2222-222222222222') = 0,
    'm1 must NOT see m2 user row';

  -- tier rank is DB-derived from the active subscription
  ASSERT app.current_tier_rank() = 2, 'm1 active tier rank should be 2';

  -- tier gate: published <= tier2 visible; tier3 hidden; drafts hidden
  ASSERT (SELECT count(*) FROM content WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1,
    'm1 should see published tier1 content';
  ASSERT (SELECT count(*) FROM content WHERE id = 'aaaaaaaa-0000-0000-0000-000000000003') = 0,
    'm1 must NOT see tier3 content above their tier';

  -- ── CR-001 free trial: an ACTIVE trial opens the PUBLISHED free set only ──────
  ASSERT app.has_active_trial(), 'm1 trial (started now) should be active';
  ASSERT (SELECT count(*) FROM content WHERE id = 'ffffffff-0000-0000-0000-000000000001') = 1,
    'm1 with an active trial should see the published free-set row (above their tier)';
  -- The trial branch grants ONLY free_preview rows: a paid tier-3 row that is NOT in the
  -- free set stays hidden even with the trial active (proven by the tier3 assertion above,
  -- which holds while m1 has a trial). And the free set still respects publication:
  ASSERT (SELECT count(*) FROM content WHERE id = 'ffffffff-0000-0000-0000-000000000002') = 0,
    'a DRAFT free-set row must stay hidden (free_preview never bypasses publication)';
  -- G-7: no row ⇒ no thumbnail. Stated as its own assertion so a future policy change
  -- that exposed the row would fail here on the artwork, not just on the title.
  -- Scoped to the fixture id on purpose: an unscoped count would also see whatever real
  -- content the environment happens to hold, and would pass or fail for the wrong reason.
  ASSERT (SELECT count(*) FROM content
          WHERE id = 'aaaaaaaa-0000-0000-0000-000000000003'
            AND thumbnail_object_key IS NOT NULL) = 0,
    'm1 must NOT read the thumbnail key of above-tier content';
  ASSERT (SELECT count(*) FROM content WHERE id = 'aaaaaaaa-0000-0000-0000-000000000009') = 0,
    'm1 must NOT see draft content';

  -- auth-secret table: privileges revoked -> permission denied, not just 0 rows
  BEGIN
    PERFORM count(*) FROM auth_identities;
    RAISE EXCEPTION 'auth_identities must be denied to the app role';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected
  END;

  -- write-path: member cannot self-insert a subscription to escalate tier
  BEGIN
    INSERT INTO subscriptions (id, user_id, programme_id, status, updated_at)
    SELECT gen_random_uuid(), app.current_user_id(), p.id, 'active', now()
    FROM programmes p WHERE p.tier_rank = 4;
    RAISE EXCEPTION 'member must NOT insert own subscription';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: subscriptions_write requires is_staff()
  END;

  -- write-path: member cannot raise their own role (BEFORE UPDATE trigger)
  BEGIN
    UPDATE users SET role = 'administrator' WHERE id = app.current_user_id();
    RAISE EXCEPTION 'member must NOT escalate own role';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- expected: trg_users_prevent_role_change fires
  END;

  -- write-path: member cannot write their own admin-private notes (same trigger)
  BEGIN
    UPDATE users SET notes = 'i wrote this' WHERE id = app.current_user_id();
    RAISE EXCEPTION 'member must NOT write own admin-private notes';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- expected: trg_users_prevent_role_change freezes notes for non-staff
  END;

  -- G-6 write-path: member cannot rewind their own 8-week map anchor (same trigger).
  -- Belt to the API's suspenders — PATCH /me does not accept the field either.
  BEGIN
    UPDATE users SET plan_started_at = now() WHERE id = app.current_user_id();
    RAISE EXCEPTION 'member must NOT write own plan_started_at';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- expected: trg_users_prevent_role_change freezes plan_started_at
  END;

  -- CR-001 write-path: a member cannot self-grant or extend a free trial (the trigger
  -- freezes trial_started_at for non-staff). This is the guard that makes the free set
  -- an entitlement the DB controls, not one PATCH /me could ever hand out.
  BEGIN
    UPDATE users SET trial_started_at = now() WHERE id = app.current_user_id();
    RAISE EXCEPTION 'member must NOT write own trial_started_at';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- expected: trg_users_prevent_role_change freezes trial_started_at
  END;

  -- Soft-delete write-path: a member cannot self-set deleted_at via PATCH (the delete
  -- endpoint writes it on the service role). Same trigger guard.
  BEGIN
    UPDATE users SET deleted_at = now() WHERE id = app.current_user_id();
    RAISE EXCEPTION 'member must NOT write own deleted_at';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- expected: trg_users_prevent_role_change freezes deleted_at
  END;

  -- Admin-disable write-path: a member cannot self-clear/set disabled_at (else they
  -- could re-enable their own admin-blocked account). Admin writes it via service role.
  BEGIN
    UPDATE users SET disabled_at = now() WHERE id = app.current_user_id();
    RAISE EXCEPTION 'member must NOT write own disabled_at';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- expected: trg_users_prevent_role_change freezes disabled_at
  END;

  -- ── G-4: content_completions is OWN-ONLY and APPEND-ONLY ───────────────────
  ASSERT (SELECT count(*) FROM content_completions) = 1,
    'm1 must see exactly its own completion event, never m2''s';

  -- Immutability is enforced by the ABSENCE of UPDATE/DELETE policies, not by the
  -- API. Deny-by-default means these match ZERO rows rather than raising — so the
  -- assertion is on the row count, which is the only thing that proves it.
  UPDATE content_completions SET duration_seconds = 9999
   WHERE id = 'cccccccc-0000-0000-0000-000000000001';
  ASSERT (SELECT duration_seconds FROM content_completions
          WHERE id = 'cccccccc-0000-0000-0000-000000000001') = 600,
    'member must NOT be able to UPDATE a completion event (append-only)';

  DELETE FROM content_completions WHERE id = 'cccccccc-0000-0000-0000-000000000001';
  ASSERT (SELECT count(*) FROM content_completions
          WHERE id = 'cccccccc-0000-0000-0000-000000000001') = 1,
    'member must NOT be able to DELETE a completion event (append-only)';

  -- A member CAN append their own, and CANNOT append one attributed to someone else.
  INSERT INTO content_completions (id, user_id, content_id, duration_seconds)
  VALUES (gen_random_uuid(), app.current_user_id(), 'aaaaaaaa-0000-0000-0000-000000000001', 60);
  BEGIN
    INSERT INTO content_completions (id, user_id, content_id, duration_seconds)
    VALUES (gen_random_uuid(), '22222222-2222-2222-2222-222222222222',
            'aaaaaaaa-0000-0000-0000-000000000001', 60);
    RAISE EXCEPTION 'member must NOT insert a completion for another member';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: content_completions_insert WITH CHECK (user_id = current_user_id())
  END;

  -- ── G-5: an INACTIVE browse tile is invisible to a non-staff session ────────
  ASSERT (SELECT count(*) FROM content_categories WHERE slug = 'rls-active') = 1,
    'member should see an active category tile';
  ASSERT (SELECT count(*) FROM content_categories WHERE slug = 'rls-inactive') = 0,
    'member must NOT see an inactive category tile';
  -- content_categories_write requires is_staff(), and a failing USING clause on an
  -- UPDATE matches ZERO rows rather than raising — so assert on the value, not on an
  -- exception. (Contrast the subscriptions INSERT above: a failing WITH CHECK does raise.)
  UPDATE content_categories SET label = 'hijacked' WHERE slug = 'rls-active';
  ASSERT (SELECT label FROM content_categories WHERE slug = 'rls-active') = 'RLS Active',
    'member must NOT write a category tile';

  -- ── CR-003: translations read MIRRORS the parent SELECT; locales active-read ──
  ASSERT (SELECT count(*) FROM translations
          WHERE entity_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1,
    'm1 must READ a translation for content it can see (tier1)';
  ASSERT (SELECT count(*) FROM translations
          WHERE entity_id = 'aaaaaaaa-0000-0000-0000-000000000003') = 0,
    'm1 must NOT read a translation for above-tier content (tier3) — mirrors content_select';
  ASSERT (SELECT count(*) FROM locales WHERE code = 'en' AND is_active) = 1,
    'm1 must see the active base locale';
  ASSERT (SELECT count(*) FROM locales WHERE code = 'fr') = 0,
    'm1 must NOT see an inactive locale (only `en` is active in R1)';
  -- staff-write: a member cannot author a translation (WITH CHECK is_staff() → raises).
  BEGIN
    INSERT INTO translations (id, entity_type, entity_id, field, locale, value, updated_at)
    VALUES (gen_random_uuid(), 'content', 'aaaaaaaa-0000-0000-0000-000000000001', 'description', 'fr', 'x', now());
    RAISE EXCEPTION 'member must NOT write a translation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: translations_write requires is_staff()
  END;
  -- staff-write on locales: a failing USING clause on UPDATE matches ZERO rows (same
  -- shape as content_categories above), so assert on the value, not on an exception.
  UPDATE locales SET name = 'hijacked' WHERE code = 'en';
  ASSERT (SELECT name FROM locales WHERE code = 'en') = 'English',
    'member must NOT write a locale row';
END $$;

-- ── assert m2 (no subscription) is gated to tier 0 ───────────────────────────
SELECT set_config('app.user_id',   '22222222-2222-2222-2222-222222222222', true);
DO $$
BEGIN
  ASSERT app.current_tier_rank() = 0, 'm2 with no active sub should be tier 0';
  ASSERT (SELECT count(*) FROM content WHERE required_tier_rank >= 1) = 0,
    'm2 must see no tier-gated content';
  -- CR-001: m2's trial LAPSED (16 days ago), so the free set has dropped — even the
  -- published free-set row is invisible. This is the "validity 15 days" guarantee.
  ASSERT NOT app.has_active_trial(), 'm2 trial (16 days old) must be expired';
  ASSERT (SELECT count(*) FROM content WHERE id = 'ffffffff-0000-0000-0000-000000000001') = 0,
    'm2 with a LAPSED trial must NOT see the free set';
END $$;

-- ── assert staff sees everything incl. drafts ────────────────────────────────
SELECT set_config('app.user_role', 'administrator', true);
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM content
          WHERE id IN ('aaaaaaaa-0000-0000-0000-000000000003',
                       'aaaaaaaa-0000-0000-0000-000000000009')) = 2,
    'staff should see tier3 + draft content';
  ASSERT (SELECT count(*) FROM users
          WHERE id IN ('11111111-1111-1111-1111-111111111111',
                       '22222222-2222-2222-2222-222222222222')) = 2,
    'staff should see all members';
  -- CR-003: staff read EVERY translation (they author them) incl. the above-tier row a
  -- member could not see, and see an INACTIVE locale.
  ASSERT (SELECT count(*) FROM translations
          WHERE entity_id = 'aaaaaaaa-0000-0000-0000-000000000003') = 1,
    'staff must read the translation of above-tier content';
  ASSERT (SELECT count(*) FROM locales WHERE code = 'fr') = 1,
    'staff must see an inactive locale';
  -- G-4: staff READ every member's completions (the admin client profile shows a
  -- progress summary) — 2 seeded + the 1 m1 appended above.
  ASSERT (SELECT count(*) FROM content_completions) = 3,
    'staff should see all members'' completion events';
  -- ...but append-only binds staff too: there is no UPDATE/DELETE policy for ANYONE
  -- on the app role, so a compromised admin session cannot rewrite history either.
  DELETE FROM content_completions;
  ASSERT (SELECT count(*) FROM content_completions) = 3,
    'not even a staff app-role session may DELETE a completion event';
  -- G-5: staff see inactive tiles (they manage them).
  ASSERT (SELECT count(*) FROM content_categories WHERE slug = 'rls-inactive') = 1,
    'staff should see an inactive category tile';
END $$;

-- ── regression: deactivating a programme must NOT drop a paying member's tier ─
-- Guards the SECURITY DEFINER on app.current_tier_rank(). Without it, the
-- programmes RLS (is_active OR is_staff) hides the deactivated programme from the
-- member and their tier collapses to 0, revoking content mid-subscription.
RESET ROLE;                                          -- back to owner to flip flag
UPDATE programmes SET is_active = false WHERE tier_rank = 2;
SET LOCAL ROLE ashta_app;
SELECT set_config('app.user_id',   '11111111-1111-1111-1111-111111111111', true);
SELECT set_config('app.user_role', 'member', true);
DO $$
BEGIN
  ASSERT app.current_tier_rank() = 2,
    'deactivating a programme must NOT collapse an active subscriber tier';
  ASSERT (SELECT count(*) FROM content WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1,
    'member keeps content access when their programme is deactivated';
END $$;

RESET ROLE;
ROLLBACK;

\echo 'RLS verification PASSED'
