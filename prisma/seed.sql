-- Ashta Eight — dev seed: the four programmes (tiers).
-- Idempotent (ON CONFLICT on the stable `code`). Prices in pence (GBP).
-- Stripe price IDs are set later, per environment. Names/prices chosen by the
-- Architect (D1) — client may rename/re-price without a migration.
-- Run: psql "$DATABASE_URL" -f prisma/seed.sql  (see package.json db:seed)
-- Use the SAME privileged connection as migrations (DATABASE_URL owner —
-- superuser/BYPASSRLS in dev). FORCE RLS blocks writes for the app role, so
-- do NOT seed via ashta_app.

-- ⚠️ CLIENT COPY REQUIRED (DESIGN_GAPS G-1). The four feature lists are EMPTY on
-- purpose. The Figma export's rows are placeholder — all three cards repeat the
-- same tier — and CLAUDE.md §5.1 forbids inventing marketing copy. When the client
-- supplies the real four rows per tier, replace ARRAY[]::text[] below with e.g.
--   ARRAY['…','…','…','…']::text[]
-- (order = top-to-bottom on the card) and re-run `npm run db:seed`. No migration,
-- no deploy, no app-store release. Max 8 rows, <= 120 chars each (DB CHECK + Zod).
INSERT INTO programmes
  (id, code, name, description, tier_rank, price_minor, currency, billing_interval, auto_renew, is_active, features, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'ashta_foundations', 'Ashta Foundations',
   'Entry tier — face-yoga (Align) foundations.',
   1, 2900,  'GBP', 'monthly', false, true, ARRAY[]::text[], now(), now()),
  (gen_random_uuid(), 'ashta_sculpt', 'Ashta Sculpt',
   'Adds subconscious reprogramming (Sculpt). Auto-renewing membership.',
   2, 5900,  'GBP', 'monthly', true,  true, ARRAY[]::text[], now(), now()),
  (gen_random_uuid(), 'ashta_evolve', 'Ashta Evolve',
   'Adds quantum-identity work (Evolve) — the full self-practice library.',
   3, 9900,  'GBP', 'monthly', false, true, ARRAY[]::text[], now(), now()),
  (gen_random_uuid(), 'ashta_signature', 'Ashta Signature',
   'Top tier — everything, plus Live Cohort sessions and 1:1 coaching.',
   4, 19900, 'GBP', 'monthly', false, true, ARRAY[]::text[], now(), now())
ON CONFLICT (code) DO UPDATE SET
  name             = EXCLUDED.name,
  description      = EXCLUDED.description,
  tier_rank        = EXCLUDED.tier_rank,
  price_minor      = EXCLUDED.price_minor,
  billing_interval = EXCLUDED.billing_interval,
  auto_renew       = EXCLUDED.auto_renew,
  is_active        = EXCLUDED.is_active,
  -- Only overwrite when the seed actually carries copy, so re-running db:setup
  -- on an environment cannot wipe features an admin edited in the console.
  features         = COALESCE(NULLIF(EXCLUDED.features, ARRAY[]::text[]), programmes.features),
  updated_at       = now();

-- ─────────────────────────────────────────────────────────────────────────────
-- Home-screen browse tiles (DESIGN_GAPS G-5). Idempotent on the stable `slug`.
--
-- ⚠️ CLIENT DEFINITION REQUIRED. The four LABELS and ICONS below are taken from the
-- approved design (Figma `65:3717`) — they are the client's own words, not invented.
-- What each tile CONTAINS is not, and the Architect will not guess it: `pillar` and
-- `type` are therefore left NULL on every row.
--
-- A NULL filter means "no filter", which would make an unconfigured tile return
-- EVERYTHING — worse than inert. So the API treats a category with no filter as
-- UNCONFIGURED and returns an empty page with `total: 0`. The failure mode is
-- visibly empty rather than quietly wrong. Until the client answers, tapping a tile
-- shows an empty list; that is intended.
--
-- There is NO admin-UI screen for these tiles (R1) — they are edited in the DB only.
-- To configure a tile, set its pillar and/or type HERE and re-run `npm run db:seed`
-- (the upsert below overwrites both, deliberately — unlike programmes.features,
-- these are not admin-edited copy), or UPDATE content_categories directly. No
-- migration, no app release: the app only ever knows the slug, and the slug→content
-- resolution is entirely server-side. (Mirrored in admin/README.md.)
--
-- ⚠️ ONE CLIENT ANSWER VOIDS THIS TABLE: if these four are meant to REPLACE
-- align/sculpt/evolve, that is a CHANGE REQUEST, not a seed edit — `pillar` is baked
-- into the recommendation engine, the questionnaire and admin content management.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO content_categories
  (id, slug, label, icon_key, pillar, type, position, is_active, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'somatic-programs',  'Somatic Programs',  'somatic', NULL, NULL, 1, true, now(), now()),
  (gen_random_uuid(), 'face-architecture', 'Face Architecture', 'face',    NULL, NULL, 2, true, now(), now()),
  (gen_random_uuid(), 'neural-audio',      'Neural Audio',      'audio',   NULL, NULL, 3, true, now(), now()),
  (gen_random_uuid(), 'stress-recovery',   'Stress Recovery',   'stress',  NULL, NULL, 4, true, now(), now())
ON CONFLICT (slug) DO UPDATE SET
  label      = EXCLUDED.label,
  icon_key   = EXCLUDED.icon_key,
  pillar     = EXCLUDED.pillar,
  type       = EXCLUDED.type,
  position   = EXCLUDED.position,
  is_active  = EXCLUDED.is_active,
  updated_at = now();


-- ─────────────────────────────────────────────────────────────────────────────
-- CR-008 — Info pages (privacy/terms/about). The three slugs the app asks for exist
-- from day one so the endpoints resolve; bodies are EMPTY and is_published = FALSE, so
-- each page 404s until an admin publishes real copy via the admin editor (Pages section).
-- 🔴 The copy itself is a CLIENT deliverable. FAQs are created in the admin, not seeded.
-- Idempotent on `slug`; the upsert deliberately does NOT overwrite body/title/published,
-- so re-seeding never clobbers copy an admin has already published.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO info_pages (id, slug, title, body_html, is_published, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'privacy-policy', 'Privacy Policy',       '', false, now(), now()),
  (gen_random_uuid(), 'terms',          'Terms & Conditions',   '', false, now(), now()),
  (gen_random_uuid(), 'about',          'About Ashta Eight',    '', false, now(), now())
ON CONFLICT (slug) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- Supported languages (CR-003 multilingual FOUNDATION). Idempotent on `code` (BCP-47).
-- All 20 from docs/LANGUAGES.txt are seeded; ONLY `en` is active in R1 (no user-facing
-- language picker until R2). Arabic + Urdu are RTL. `native_name` is the endonym Agent 2
-- shows in an R2 language picker.
--
-- ⚠️ ZERO `translations` rows are seeded, by design: with no translation for any field,
-- the locale-resolution read seam always returns the base/English column, so every API
-- response is byte-identical to before CR-003. The seam is inert until R2 copy lands.
-- Re-running is safe: is_active is NOT overwritten on conflict, so activating a language
-- for R2 (or in staging) survives a re-seed.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO locales (code, name, native_name, is_rtl, is_active, created_at, updated_at)
VALUES
  ('en',      'English',               'English',      false, true,  now(), now()),
  ('es',      'Spanish',               'Español',      false, false, now(), now()),
  ('fr',      'French',                'Français',     false, false, now(), now()),
  ('de',      'German',                'Deutsch',      false, false, now(), now()),
  ('it',      'Italian',               'Italiano',     false, false, now(), now()),
  ('pt',      'Portuguese',            'Português',    false, false, now(), now()),
  ('nl',      'Dutch',                 'Nederlands',   false, false, now(), now()),
  ('pl',      'Polish',                'Polski',       false, false, now(), now()),
  ('sv',      'Swedish',               'Svenska',      false, false, now(), now()),
  ('da',      'Danish',                'Dansk',        false, false, now(), now()),
  ('nb',      'Norwegian',             'Norsk Bokmål', false, false, now(), now()),
  ('ar',      'Arabic',                'العربية',       true,  false, now(), now()),
  ('tr',      'Turkish',               'Türkçe',       false, false, now(), now()),
  ('ru',      'Russian',               'Русский',      false, false, now(), now()),
  ('zh-Hans', 'Chinese (Simplified)',  '简体中文',       false, false, now(), now()),
  ('zh-Hant', 'Chinese (Traditional)', '繁體中文',       false, false, now(), now()),
  ('ja',      'Japanese',              '日本語',         false, false, now(), now()),
  ('ko',      'Korean',                '한국어',         false, false, now(), now()),
  ('hi',      'Hindi',                 'हिन्दी',          false, false, now(), now()),
  ('ur',      'Urdu',                  'اردو',          true,  false, now(), now())
ON CONFLICT (code) DO UPDATE SET
  name        = EXCLUDED.name,
  native_name = EXCLUDED.native_name,
  is_rtl      = EXCLUDED.is_rtl,
  -- is_active deliberately NOT overwritten: re-seeding must not deactivate a language
  -- that was turned on for R2/staging.
  updated_at  = now();


-- ─────────────────────────────────────────────────────────────────────────────
-- First administrator (dev). Password is bcrypt-hashed in-DB via pgcrypto — no
-- app/auth code needed. DEV CREDENTIALS — rotate before any real environment:
--   email:    admin@ashta-eight.com
--   password: ChangeMe!2026
-- 2FA is NOT enrolled here; the admin enrols via /auth/2fa/setup on first login.
-- If the auth module hashes with argon2 (not bcrypt), reset this password through
-- the reset flow so the stored hash matches the verifier.
-- ─────────────────────────────────────────────────────────────────────────────
WITH admin AS (
  INSERT INTO users (id, email, email_verified_at, display_name, role, created_at, updated_at)
  VALUES (gen_random_uuid(), 'admin@ashta-eight.com', now(), 'Ashta Admin', 'administrator', now(), now())
  ON CONFLICT (email) DO UPDATE SET role = 'administrator', updated_at = now()
  RETURNING id
)
INSERT INTO auth_identities (id, user_id, provider, provider_subject, password_hash, created_at)
SELECT gen_random_uuid(), admin.id, 'password', admin.id::text,
       crypt('ChangeMe!2026', gen_salt('bf', 12)), now()
FROM admin
ON CONFLICT (provider, provider_subject) DO UPDATE SET password_hash = EXCLUDED.password_hash;


-- ─────────────────────────────────────────────────────────────────────────────
-- TEST MEMBER (dev/QA only). A plain member — role 'member', so login returns a
-- session directly rather than the staff 2FA challenge the admin above gets.
-- Email pre-verified so nothing gates sign-in.
--   email:    test@yopmail.com
--   password: Test!2026
-- yopmail is a disposable-inbox service: the address needs no real mailbox, and
-- with DEV_FIXED_RESET_OTP=true the reset code is always 000000 anyway.
-- ⚠️ Remove (or rotate) before any real environment.
-- ─────────────────────────────────────────────────────────────────────────────
WITH member AS (
  INSERT INTO users (id, email, email_verified_at, display_name, role, created_at, updated_at)
  VALUES (gen_random_uuid(), 'test@yopmail.com', now(), 'Test Member', 'member', now(), now())
  ON CONFLICT (email) DO UPDATE SET role = 'member', email_verified_at = now(), updated_at = now()
  RETURNING id
)
INSERT INTO auth_identities (id, user_id, provider, provider_subject, password_hash, created_at)
SELECT gen_random_uuid(), member.id, 'password', member.id::text,
       crypt('Test!2026', gen_salt('bf', 12)), now()
FROM member
ON CONFLICT (provider, provider_subject) DO UPDATE SET password_hash = EXCLUDED.password_hash;


-- ─────────────────────────────────────────────────────────────────────────────
-- FREE-SET DEMO CONTENT (CR-001, dev/QA only). Three PUBLISHED audio sessions
-- flagged free_preview so the 15-day free trial visibly unlocks something. They
-- sit at tier_rank 1 — ABOVE a trial member's tier 0 — so ONLY the trial branch of
-- content_select surfaces them to a trialing member; a signed-in member with no
-- trial and no package still cannot see them. Idempotent on id.
-- ⚠️ Placeholder dev content (no real S3 object behind s3_key) — the client's real
-- free set is curated by flagging content free_preview in the admin console.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO content (id, type, pillar, title, description, required_tier_rank, s3_key,
                     offline_downloadable, order_index, published_at, free_preview, created_at, updated_at)
VALUES
  ('cf000001-0000-4000-8000-000000000001', 'audio', 'align',  'Morning Reset (Free)',
   'A short guided face-yoga warm-up — part of the free trial collection.', 1, 'audio/free/morning-reset.m4a',
   false, 1, now(), true, now(), now()),
  ('cf000001-0000-4000-8000-000000000002', 'audio', 'sculpt', 'Jaw & Neck Release (Free)',
   'Release tension through the jaw and neck — free trial collection.', 1, 'audio/free/jaw-neck-release.m4a',
   false, 2, now(), true, now(), now()),
  ('cf000001-0000-4000-8000-000000000003', 'audio', 'evolve', 'Evening Wind-Down (Free)',
   'A calming subconscious wind-down session — free trial collection.', 1, 'audio/free/evening-wind-down.m4a',
   false, 3, now(), true, now(), now())
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description,
  required_tier_rank = EXCLUDED.required_tier_rank, s3_key = EXCLUDED.s3_key,
  published_at = EXCLUDED.published_at, free_preview = EXCLUDED.free_preview, updated_at = now();


-- ─────────────────────────────────────────────────────────────────────────────
-- FULLY-ONBOARDED TEST MEMBER (dev/QA only) — demonstrates the "non first time
-- user → straight to Dashboard" case (CR-004 case 3). Unlike test@yopmail.com
-- (registered but NO questionnaire → routed through onboarding = case 2), this
-- member has a completed+claimed questionnaire AND an active 15-day free trial, so
-- login/relaunch lands directly on the Dashboard.
--   email:    onboarded@yopmail.com
--   password: Test!2026
-- ⚠️ Remove/rotate before any real environment.
-- ─────────────────────────────────────────────────────────────────────────────
WITH ob AS (
  INSERT INTO users (id, email, email_verified_at, display_name, role, trial_started_at, created_at, updated_at)
  VALUES (gen_random_uuid(), 'onboarded@yopmail.com', now(), 'Onboarded Member', 'member', now(), now(), now())
  ON CONFLICT (email) DO UPDATE SET role = 'member', email_verified_at = now(),
    trial_started_at = now(), updated_at = now()
  RETURNING id
), ident AS (
  INSERT INTO auth_identities (id, user_id, provider, provider_subject, password_hash, created_at)
  SELECT gen_random_uuid(), ob.id, 'password', ob.id::text, crypt('Test!2026', gen_salt('bf', 12)), now()
  FROM ob
  ON CONFLICT (provider, provider_subject) DO UPDATE SET password_hash = EXCLUDED.password_hash
  RETURNING user_id
)
-- A completed+claimed questionnaire result so GET /me/recommendation is non-null
-- (the questionnaire gate is satisfied). Idempotent per user_id.
INSERT INTO recommendation_requests
  (id, user_id, session_key, input_type, input, gdpr_consent_at, recommended_programme_id, rationale, engine_version, created_at)
SELECT gen_random_uuid(), ob.id, gen_random_uuid()::text, 'questionnaire', '{"answers":[]}'::jsonb, now(),
       (SELECT id FROM programmes WHERE code = 'ashta_foundations'),
       'Seeded onboarded member — demonstrates the direct-to-dashboard case.', '1.0.0', now()
FROM ob
WHERE NOT EXISTS (SELECT 1 FROM recommendation_requests r WHERE r.user_id = ob.id);


-- ─────────────────────────────────────────────────────────────────────────────
-- PROGRAMS & AUDIO DEMO CONTENT (dev/QA only) — "seed for visibility". These are
-- tier_rank 0, so they are visible to ANY signed-in member regardless of
-- subscription/trial — the Programs tab (type=video), Audio tab (type=audio) and
-- the dashboard are never empty in a demo. Idempotent on id. Placeholder dev data
-- (no real S3/video asset behind the ref); the client's real catalogue is created
-- via the admin content tools. ⚠️ Remove before any real environment.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO content (id, type, pillar, title, description, required_tier_rank, video_ref, s3_key,
                     offline_downloadable, week_number, order_index, published_at, free_preview, created_at, updated_at)
VALUES
  -- Video "programs"
  ('c0000001-0000-4000-8000-000000000001', 'video', 'align',  'Mindful Movement',
   'Three movements. One ancient practice, refined. A gentle face-yoga warm-up to lift and tone.',
   0, 'demo-mindful-movement', NULL, false, NULL, 1, now(), false, now(), now()),
  ('c0000001-0000-4000-8000-000000000002', 'video', 'sculpt', 'Sculpt & Define',
   'Targeted sculpting sequences for the jaw, cheeks and brow.',
   0, 'demo-sculpt-define', NULL, false, NULL, 2, now(), false, now(), now()),
  ('c0000001-0000-4000-8000-000000000003', 'video', 'evolve', 'Deep Realignment',
   'A slower, restorative session focused on symmetry and release.',
   0, 'demo-deep-realignment', NULL, false, NULL, 3, now(), false, now(), now()),
  ('c0000001-0000-4000-8000-000000000004', 'video', 'align',  'Office Recovery',
   'A five-minute reset for tension held through a working day.',
   0, 'demo-office-recovery', NULL, false, NULL, 4, now(), false, now(), now()),
  -- Audio sessions
  ('c0000001-0000-4000-8000-000000000005', 'audio', 'evolve', 'Alpha Flow',
   '12 min • Cognitive Focus. A neural-entrainment session to settle into flow.',
   0, NULL, 'audio/demo/alpha-flow.m4a', false, NULL, 1, now(), false, now(), now()),
  ('c0000001-0000-4000-8000-000000000006', 'audio', 'evolve', 'Deep Focus',
   '25 min • Neural Entrainment. A longer session for sustained concentration.',
   0, NULL, 'audio/demo/deep-focus.m4a', false, NULL, 2, now(), false, now(), now())
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title, description = EXCLUDED.description,
  required_tier_rank = EXCLUDED.required_tier_rank, video_ref = EXCLUDED.video_ref,
  s3_key = EXCLUDED.s3_key, week_number = EXCLUDED.week_number, order_index = EXCLUDED.order_index,
  published_at = EXCLUDED.published_at, updated_at = now();


-- ─────────────────────────────────────────────────────────────────────────────
-- COACHING SLOTS DEMO (dev/QA only) — so Session Booking shows availability. Three
-- open future slots owned by the seeded admin. Zoom is best-effort: a booking is
-- created even when Zoom is unconfigured (the join_url backfills later), so booking
-- works in the demo. Idempotent on id. ⚠️ Remove before any real environment.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO coaching_slots (id, owner_id, starts_at, ends_at, capacity, status, created_at, updated_at)
SELECT v.id, a.id, v.starts_at, v.ends_at, 1, 'open', now(), now()
FROM (VALUES
  ('d1000001-0000-4000-8000-000000000001'::uuid, now() + interval '2 days'  + interval '15 hours', now() + interval '2 days'  + interval '16 hours'),
  ('d1000001-0000-4000-8000-000000000002'::uuid, now() + interval '4 days'  + interval '17 hours', now() + interval '4 days'  + interval '18 hours'),
  ('d1000001-0000-4000-8000-000000000003'::uuid, now() + interval '7 days'  + interval '10 hours', now() + interval '7 days'  + interval '11 hours')
) AS v(id, starts_at, ends_at)
CROSS JOIN (SELECT id FROM users WHERE role = 'administrator' ORDER BY created_at LIMIT 1) AS a
ON CONFLICT (id) DO UPDATE SET
  starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, status = 'open', updated_at = now();


-- ─────────────────────────────────────────────────────────────────────────────
-- NOTIFICATIONS DEMO (dev/QA only) — so the Notifications screen shows content
-- grouped by day (Today / Yesterday / older), a mix of the three R1 types and of
-- read/unread. Written for BOTH seeded members. sent_at is set (these are
-- "delivered" in-app rows, independent of real FCM push). ⚠️ dev-only.
--
-- Idempotent by clearing THESE two dev accounts' notifications first (ids are random,
-- so a plain re-insert would pile up duplicates). Scoped to the seeded dev emails only.
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM notifications WHERE user_id IN (
  SELECT id FROM users WHERE email IN ('test@yopmail.com','onboarded@yopmail.com')
);
INSERT INTO notifications (id, user_id, type, title, body, data, sent_at, read_at, created_at)
SELECT gen_random_uuid(), u.id, v.type::"NotificationType", v.title, v.body, '{}'::jsonb,
       v.created_at, v.read_at, v.created_at
FROM (SELECT id FROM users WHERE email IN ('test@yopmail.com','onboarded@yopmail.com')) AS u
CROSS JOIN (VALUES
  -- Today (unread)
  ('new_content',      'New session available',      'Mindful Movement has just been added to your programme. Tap to begin.',      now() - interval '2 hours',  NULL::timestamptz),
  ('session_reminder', 'Coaching session tomorrow',  'Your 1:1 somatic coaching session is tomorrow at 3:00 PM.',                   now() - interval '5 hours',  NULL),
  -- Yesterday (one read, one unread)
  ('new_content',      'New audio: Deep Focus',      'A 25-minute neural-entrainment session is now in your Audio library.',        now() - interval '1 day' - interval '3 hours', now() - interval '20 hours'),
  ('renewal_reminder', 'Your trial ends soon',       'Your 15-day free trial ends in 3 days. Choose a membership to keep your practice going.', now() - interval '1 day' - interval '6 hours', NULL),
  -- Older (read)
  ('session_reminder', 'Welcome to Ashta Eight',     'Your journey starts here. Explore your recommended programme and book a coaching session any time.', now() - interval '4 days', now() - interval '4 days')
) AS v(type, title, body, created_at, read_at)
ON CONFLICT (id) DO NOTHING;
