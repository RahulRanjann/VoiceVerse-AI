DO $voiceverse$
DECLARE
  api_role name;
  confidential_table name;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "workflow_stages" AS stage
    JOIN "workflow_stage_attempts" AS attempt
      ON attempt."stage_id" = stage."id" AND attempt."attempt_number" = 1
    WHERE stage."id" = '77777777-7777-4777-8777-777777777777'
      AND stage."configuration_hash" = attempt."configuration_hash"
      AND stage."configuration_snapshot"->>'contract' = 'voiceverse.media-preparation.v1'
  ) THEN
    RAISE EXCEPTION 'M5 rehearsal failed: workflow configuration backfill is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "artifact_lineage"
    WHERE "id" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND "organization_id" = '22222222-2222-4222-8222-222222222222'
      AND "project_id" = '44444444-4444-4444-8444-444444444444'
      AND "source_video_id" = '55555555-5555-4555-8555-555555555555'
  ) THEN
    RAISE EXCEPTION 'M5 rehearsal failed: artifact-lineage tenant backfill is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'M5 rehearsal failed: an unvalidated public constraint remains';
  END IF;

  FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    FOREACH confidential_table IN ARRAY ARRAY[
      'workflow_stage_dependencies'::name,
      'workflow_job_artifact_inputs'::name,
      'speech_analyses'::name,
      'transcription_runs'::name,
      'transcript_segments'::name,
      'transcript_words'::name,
      'diarization_runs'::name,
      'speaker_clusters'::name,
      'speaker_turns'::name,
      'characters'::name,
      'character_identification_runs'::name,
      'speaker_character_assignments'::name,
      'dialogue_segments'::name,
      'project_speech_analysis_selections'::name
    ]
    LOOP
      IF has_table_privilege(api_role, format('public.%I', confidential_table), 'SELECT') THEN
        RAISE EXCEPTION
          'M5 rehearsal failed: role % retains SELECT on %',
          api_role,
          confidential_table;
      END IF;
    END LOOP;
  END LOOP;
END
$voiceverse$;
