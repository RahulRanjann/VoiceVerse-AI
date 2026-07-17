-- This verification raises on any effective Data API privilege so CI cannot
-- mistake a successful query that returned rows for a successful isolation gate.
-- Disabling the Data API in the Supabase dashboard is an additional mandatory gate.
DO $voiceverse$
DECLARE
  api_role name;
  exposed_relation record;
  exposed_sequence record;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      CONTINUE;
    END IF;

    FOR exposed_relation IN
      SELECT namespace.nspname AS schema_name, relation.relname AS relation_name
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('f', 'm', 'p', 'r', 'v')
        AND (
          has_table_privilege(api_role, relation.oid, 'SELECT')
          OR has_table_privilege(api_role, relation.oid, 'INSERT')
          OR has_table_privilege(api_role, relation.oid, 'UPDATE')
          OR has_table_privilege(api_role, relation.oid, 'DELETE')
          OR has_table_privilege(api_role, relation.oid, 'TRUNCATE')
          OR has_table_privilege(api_role, relation.oid, 'REFERENCES')
          OR has_table_privilege(api_role, relation.oid, 'TRIGGER')
        )
    LOOP
      RAISE EXCEPTION
        'Supabase Data API isolation failed: role % can access %.%',
        api_role,
        exposed_relation.schema_name,
        exposed_relation.relation_name;
    END LOOP;

    FOR exposed_sequence IN
      SELECT namespace.nspname AS schema_name, sequence.relname AS sequence_name
      FROM pg_class AS sequence
      JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
      WHERE namespace.nspname = 'public'
        AND sequence.relkind = 'S'
        AND (
          has_sequence_privilege(api_role, sequence.oid, 'SELECT')
          OR has_sequence_privilege(api_role, sequence.oid, 'UPDATE')
          OR has_sequence_privilege(api_role, sequence.oid, 'USAGE')
        )
    LOOP
      RAISE EXCEPTION
        'Supabase Data API isolation failed: role % can access %.%',
        api_role,
        exposed_sequence.schema_name,
        exposed_sequence.sequence_name;
    END LOOP;
  END LOOP;
END
$voiceverse$;
