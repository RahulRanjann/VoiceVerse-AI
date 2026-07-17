-- Representative, constraint-valid Milestone 4 state used by the forward-upgrade
-- rehearsal. IDs and content are synthetic and carry no production credentials.
DO $voiceverse$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$voiceverse$;

INSERT INTO "users" ("id", "email", "display_name", "updated_at")
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'migration@example.com',
  'Migration User',
  CURRENT_TIMESTAMP
);

INSERT INTO "organizations" ("id", "slug", "display_name", "updated_at")
VALUES (
  '22222222-2222-4222-8222-222222222222',
  'migration-org',
  'Migration Org',
  CURRENT_TIMESTAMP
);

INSERT INTO "organization_memberships" (
  "id", "organization_id", "user_id", "role", "updated_at"
)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'owner',
  CURRENT_TIMESTAMP
);

INSERT INTO "projects" (
  "id", "organization_id", "created_by_user_id", "source_language_id",
  "name", "status", "updated_at"
)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  '019b52ac-4000-7000-8000-000000000001',
  'Migration Movie',
  'ready',
  CURRENT_TIMESTAMP
);

INSERT INTO "videos" (
  "id", "organization_id", "project_id", "created_by_user_id",
  "original_filename", "media_type", "byte_size", "sha256", "storage_bucket",
  "storage_key", "ingest_status", "security_status", "uploaded_at", "updated_at"
)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  'movie.mp4',
  'video/mp4',
  1000,
  repeat('a', 64),
  'media',
  'source/movie.mp4',
  'uploaded',
  'clean',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "workflow_jobs" (
  "id", "organization_id", "project_id", "source_video_id", "created_by_user_id",
  "kind", "status", "pipeline_version", "idempotency_key", "revision",
  "started_at", "completed_at", "updated_at"
)
VALUES (
  '66666666-6666-4666-8666-666666666666',
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  'source_preparation',
  'succeeded',
  'source-preparation-v1',
  'migration-job',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "workflow_stages" (
  "id", "job_id", "key", "kind", "status", "ordinal", "weight_basis_points",
  "progress_basis_points", "max_attempts", "ready_at", "started_at", "completed_at",
  "updated_at"
)
VALUES (
  '77777777-7777-4777-8777-777777777777',
  '66666666-6666-4666-8666-666666666666',
  'source-media-preparation',
  'source_media_preparation',
  'succeeded',
  0,
  10000,
  10000,
  3,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "workflow_stage_attempts" (
  "id", "stage_id", "attempt_number", "status", "command_idempotency_key",
  "progress_basis_points", "executor_version", "configuration_hash", "started_at",
  "completed_at", "updated_at"
)
VALUES (
  '88888888-8888-4888-8888-888888888888',
  '77777777-7777-4777-8777-777777777777',
  1,
  'succeeded',
  'migration-attempt',
  10000,
  'migration-test',
  repeat('b', 64),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "media_artifacts" (
  "id", "organization_id", "project_id", "source_video_id", "producer_attempt_id",
  "kind", "media_type", "byte_size", "sha256", "storage_bucket", "storage_key",
  "producer_name", "producer_version", "configuration_hash"
)
VALUES (
  '99999999-9999-4999-8999-999999999999',
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '88888888-8888-4888-8888-888888888888',
  'analysis_audio',
  'audio/flac',
  100,
  repeat('c', 64),
  'media',
  'analysis/audio.flac',
  'ffmpeg',
  '1',
  repeat('b', 64)
);

INSERT INTO "media_audio_artifacts" (
  "artifact_id", "codec_name", "sample_rate_hz", "channels", "duration_ms"
)
VALUES (
  '99999999-9999-4999-8999-999999999999',
  'flac',
  16000,
  1,
  12345
);

INSERT INTO "artifact_lineage" (
  "id", "output_artifact_id", "input_video_id", "role"
)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '99999999-9999-4999-8999-999999999999',
  '55555555-5555-4555-8555-555555555555',
  'source'
);

-- Simulate Supabase Data API default grants appearing between releases. The M5
-- migration must remove access from every newly created confidential table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon, authenticated, service_role;
