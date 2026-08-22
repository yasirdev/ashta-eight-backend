-- Ashta Eight — DB roles (run ONCE, before policies.sql, as a superuser/owner).
-- See policies.sql header for the two-role RLS model.
-- Passwords are placeholders — set real secrets via env at provision time.

-- App role: handles all authenticated member/admin requests. RLS ENFORCED.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ashta_app') THEN
    CREATE ROLE ashta_app LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- Service role: unauthenticated/system flows only (registration, login, token
-- issuance, Stripe webhook, FCM logging, anon questionnaire, cron sweeps).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ashta_service') THEN
    CREATE ROLE ashta_service LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER BYPASSRLS;
  END IF;
END $$;

-- Replace ashta_eight with the real database name at provision time:
-- GRANT CONNECT ON DATABASE ashta_eight TO ashta_app, ashta_service;
GRANT USAGE ON SCHEMA public TO ashta_app, ashta_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ashta_service;
