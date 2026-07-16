-- VoiceVerse uses Supabase as private managed PostgreSQL, not as a browser Data API.
-- Supabase-managed API roles do not exist in ordinary PostgreSQL installations, so
-- this migration remains portable by revoking grants only when those roles exist.
DO $voiceverse$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
        api_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$voiceverse$;
