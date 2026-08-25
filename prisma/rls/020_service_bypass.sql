-- Emulates BYPASSRLS for the service role on hosts where the role
-- attribute cannot be granted (cPanel / shared PostgreSQL).
-- Idempotent. Must run after policies.sql and after EVERY migration
-- that adds a new RLS-enabled table.

SELECT set_config('ashta.svc_role', :'service_role', false);

DO $$
DECLARE
  t   text;
  svc text := current_setting('ashta.svc_role');
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS p_service_bypass ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY p_service_bypass ON public.%I
         AS PERMISSIVE FOR ALL
         TO %I
         USING (current_user = %L)
         WITH CHECK (current_user = %L)',
      t, svc, svc, svc
    );
  END LOOP;
END $$;