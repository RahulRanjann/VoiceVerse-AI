-- This query must return zero rows before a Supabase environment is approved.
-- Disabling the Data API in the Supabase dashboard is an additional mandatory gate.
SELECT
  grantee,
  table_schema,
  table_name,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY grantee, table_name, privilege_type;
