DO $voiceverse$
DECLARE
  api_role name;
  confidential_table name;
  expected_tables CONSTANT name[] := ARRAY[
    'localization_workspaces'::name,
    'localization_tracks'::name,
    'localization_scenes'::name,
    'localization_scene_revisions'::name,
    'localization_scene_selections'::name,
    'localized_dialogues'::name,
    'source_dialogue_revisions'::name,
    'source_dialogue_selections'::name,
    'dialogue_translations'::name,
    'translation_revisions'::name,
    'translation_selections'::name,
    'glossary_entries'::name,
    'glossary_revisions'::name,
    'glossary_selections'::name,
    'translation_generations'::name
  ];
BEGIN
  FOREACH confidential_table IN ARRAY expected_tables
  LOOP
    IF to_regclass(format('public.%I', confidential_table)) IS NULL THEN
      RAISE EXCEPTION 'M6 rehearsal failed: table % is missing', confidential_table;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM "localization_workspaces"
    UNION ALL
    SELECT 1
    FROM "translation_generations"
  ) THEN
    RAISE EXCEPTION 'M6 rehearsal failed: additive migration created business rows';
  END IF;

  IF lower(U&'\0130' COLLATE "und-x-icu") <> U&'i\0307'
     OR lower(U&'\1E9E' COLLATE "und-x-icu") <> U&'\00DF' THEN
    RAISE EXCEPTION 'M6 rehearsal failed: ICU glossary normalization is incompatible';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'localization_scene_revisions_append_only',
        'source_dialogue_revisions_append_only',
        'translation_revisions_append_only',
        'glossary_revisions_append_only',
        'glossary_selections_validate_projection',
        'translation_generations_immutable_provenance'
      )
  ) <> 6 THEN
    RAISE EXCEPTION 'M6 rehearsal failed: immutable/projection trigger set is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'M6 rehearsal failed: an unvalidated public constraint remains';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    FOREACH confidential_table IN ARRAY expected_tables
    LOOP
      IF has_table_privilege(api_role, format('public.%I', confidential_table), 'SELECT') THEN
        RAISE EXCEPTION
          'M6 rehearsal failed: role % retains SELECT on %',
          api_role,
          confidential_table;
      END IF;
    END LOOP;
  END LOOP;
END
$voiceverse$;
