-- Ashta Eight — role grants. Runs as the migration/owner role (the service role
-- on cPanel). Idempotent; safe to re-run. Role names come from psql vars:
--   -v app_role="$APP_ROLE" -v service_role="$SERVICE_ROLE"

-- Replace the database name at provision time if you gate CONNECT:
-- GRANT CONNECT ON DATABASE ashta_eight TO :"app_role", :"service_role";
GRANT USAGE ON SCHEMA public TO :"app_role", :"service_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"service_role";

-- Future tables created after this runs are NOT covered by the ALL TABLES grants
-- above (evaluated at statement time). Default privileges close that gap so a new
-- migration's tables are usable without re-running the blanket grants by hand.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role", :"service_role";
