-- Ashta Eight — DB roles: LOCAL DEV ONLY. NEVER run in production.
-- On managed/shared hosts (cPanel) the runtime roles already exist and are
-- provisioned by the host; there is no superuser to CREATE ROLE. Production
-- grants come from 010_grants.sql (parameterised role names).
-- Passwords are placeholders — set real secrets via env at provision time.

-- App role: handles all authenticated member/admin requests. RLS ENFORCED.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ashta_app') THEN
    CREATE ROLE ashta_app LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Service role: unauthenticated/system flows only (registration, login, token
-- issuance, Stripe webhook, FCM logging, anon questionnaire, cron sweeps).
-- Deliberately NO BYPASSRLS attribute — in EITHER environment. Local must match
-- production: on cPanel we cannot grant BYPASSRLS (needs superuser), so bypass is
-- granted per-table by the p_service_bypass policy in 020_service_bypass.sql. Keeping
-- local NOBYPASSRLS too means local testing exercises the exact mechanism production uses.
-- NOTE: CREATE ROLE is skipped when the role already exists, so an existing local role
-- keeps whatever attribute it was made with — correct it with:
--   ALTER ROLE ashta_service NOBYPASSRLS;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ashta_service') THEN
    CREATE ROLE ashta_service LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
