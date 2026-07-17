-- Durable workflow state and immutable media artifacts for source preparation.
-- PostgreSQL remains authoritative; queue state is intentionally not represented here.

-- Prisma does not wrap PostgreSQL migrations in a transaction automatically.
-- This migration contains a data preflight and must be all-or-nothing: if the
-- preflight or any later constraint fails, the database remains at Milestone 3.
BEGIN;

CREATE TYPE "workflow_job_kind" AS ENUM ('source_preparation');
CREATE TYPE "workflow_job_status" AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancel_requested',
  'canceled'
);
CREATE TYPE "workflow_stage_kind" AS ENUM ('source_media_preparation');
CREATE TYPE "workflow_stage_status" AS ENUM (
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'canceled'
);
CREATE TYPE "workflow_attempt_status" AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'canceled'
);
CREATE TYPE "workflow_entity_type" AS ENUM ('job', 'stage', 'attempt');
CREATE TYPE "media_artifact_kind" AS ENUM (
  'probe_manifest',
  'canonical_audio',
  'analysis_audio'
);
CREATE TYPE "media_stream_kind" AS ENUM ('audio', 'video', 'subtitle', 'other');
CREATE TYPE "media_track_role" AS ENUM ('primary_audio');

-- Composite candidate keys let tenant-owned children enforce that their project and
-- source video belong to the same organization, not merely that each ID exists.
CREATE UNIQUE INDEX "projects_id_organization_key"
  ON "projects" ("id", "organization_id");
CREATE UNIQUE INDEX "videos_id_project_organization_key"
  ON "videos" ("id", "project_id", "organization_id");
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "videos"
    GROUP BY "project_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Milestone 4 preflight failed: a project has multiple source videos',
      HINT = 'Split historical source videos into one project each before deploying this migration.';
  END IF;
END
$$;
DROP INDEX "videos_project_created_idx";
CREATE UNIQUE INDEX "videos_project_id_key" ON "videos" ("project_id");
CREATE INDEX "videos_workflow_reconcile_idx"
  ON "videos" ("security_status", "ingest_status", "created_at", "id");
CREATE INDEX "outbox_workflow_delivery_recovery_idx"
  ON "outbox_events" ("published_at", "id")
  WHERE "status" = 'published' AND "event_type" = 'workflow.stage.execute';
CREATE INDEX "outbox_media_scan_delivery_recovery_idx"
  ON "outbox_events" ("published_at", "id")
  WHERE "status" = 'published' AND "event_type" = 'media.scan.requested';

ALTER TABLE "malware_scan_attempts"
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "leased_until" TIMESTAMPTZ(6),
  ADD COLUMN "heartbeat_at" TIMESTAMPTZ(6),
  ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "worker_id" VARCHAR(191);
-- A scan that was active during rollout becomes an immediately expired,
-- recoverable lease. No clean/infected verdict is fabricated and the bounded
-- worker recovery path keeps the existing authoritative attempt identity.
UPDATE "malware_scan_attempts"
SET "lease_token" = "id",
    "leased_until" = CURRENT_TIMESTAMP - interval '1 second',
    "heartbeat_at" = COALESCE("started_at", "created_at"),
    "started_at" = COALESCE("started_at", "created_at"),
    "worker_id" = 'pre-m4-recovery'
WHERE "status" = 'running';
ALTER TABLE "malware_scan_attempts"
  ADD CONSTRAINT "malware_scan_attempts_recovery_count_check"
    CHECK ("recovery_count" >= 0),
  ADD CONSTRAINT "malware_scan_attempts_lease_state_check" CHECK (
    (
      "status" = 'running'
      AND "lease_token" IS NOT NULL
      AND "leased_until" IS NOT NULL
      AND "heartbeat_at" IS NOT NULL
      AND "started_at" IS NOT NULL
    )
    OR
    (
      "status" <> 'running'
      AND "lease_token" IS NULL
      AND "leased_until" IS NULL
    )
  );
CREATE INDEX "malware_scan_attempts_status_lease_idx"
  ON "malware_scan_attempts" ("status", "leased_until", "id");

CREATE TABLE "workflow_jobs" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "kind" "workflow_job_kind" NOT NULL,
  "status" "workflow_job_status" NOT NULL DEFAULT 'queued',
  "pipeline_version" VARCHAR(100) NOT NULL,
  "idempotency_key" VARCHAR(191) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "failure_code" VARCHAR(100),
  "cancel_requested_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "workflow_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_jobs_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "workflow_jobs_pipeline_version_check"
    CHECK (length(btrim("pipeline_version")) > 0),
  CONSTRAINT "workflow_jobs_idempotency_key_check"
    CHECK (length(btrim("idempotency_key")) > 0),
  CONSTRAINT "workflow_jobs_terminal_timestamp_check" CHECK (
    (("status" IN ('succeeded', 'failed', 'canceled')) AND "completed_at" IS NOT NULL)
    OR
    (("status" NOT IN ('succeeded', 'failed', 'canceled')) AND "completed_at" IS NULL)
  ),
  CONSTRAINT "workflow_jobs_cancel_timestamp_check" CHECK (
    "status" <> 'cancel_requested' OR "cancel_requested_at" IS NOT NULL
  )
);

CREATE TABLE "workflow_stages" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "kind" "workflow_stage_kind" NOT NULL,
  "status" "workflow_stage_status" NOT NULL DEFAULT 'queued',
  "ordinal" INTEGER NOT NULL,
  "weight_basis_points" INTEGER NOT NULL,
  "progress_basis_points" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "ready_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "workflow_stages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_stages_key_check" CHECK (length(btrim("key")) > 0),
  CONSTRAINT "workflow_stages_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "workflow_stages_weight_check"
    CHECK ("weight_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "workflow_stages_progress_check"
    CHECK ("progress_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "workflow_stages_max_attempts_check" CHECK ("max_attempts" > 0),
  CONSTRAINT "workflow_stages_terminal_timestamp_check" CHECK (
    (("status" IN ('succeeded', 'failed', 'canceled')) AND "completed_at" IS NOT NULL)
    OR
    (("status" NOT IN ('succeeded', 'failed', 'canceled')) AND "completed_at" IS NULL)
  )
);

CREATE TABLE "workflow_stage_attempts" (
  "id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "status" "workflow_attempt_status" NOT NULL DEFAULT 'queued',
  "command_idempotency_key" VARCHAR(191) NOT NULL,
  "lease_token" UUID,
  "leased_until" TIMESTAMPTZ(6),
  "heartbeat_at" TIMESTAMPTZ(6),
  "recovery_count" INTEGER NOT NULL DEFAULT 0,
  "worker_id" VARCHAR(191),
  "progress_basis_points" INTEGER NOT NULL DEFAULT 0,
  "executor_version" VARCHAR(100),
  "configuration_hash" CHAR(64) NOT NULL,
  "error_code" VARCHAR(100),
  "error_detail" VARCHAR(500),
  "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "workflow_stage_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_attempts_attempt_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "workflow_attempts_progress_check"
    CHECK ("progress_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "workflow_attempts_recovery_count_check" CHECK ("recovery_count" >= 0),
  CONSTRAINT "workflow_attempts_configuration_hash_check"
    CHECK ("configuration_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "workflow_attempts_command_key_check"
    CHECK (length(btrim("command_idempotency_key")) > 0),
  CONSTRAINT "workflow_attempts_running_lease_check" CHECK (
    "status" <> 'running'
    OR (
      "lease_token" IS NOT NULL
      AND "leased_until" IS NOT NULL
      AND "heartbeat_at" IS NOT NULL
      AND "worker_id" IS NOT NULL
      AND "started_at" IS NOT NULL
    )
  ),
  CONSTRAINT "workflow_attempts_terminal_timestamp_check" CHECK (
    (("status" IN ('succeeded', 'failed', 'timed_out', 'canceled')) AND "completed_at" IS NOT NULL)
    OR
    (("status" NOT IN ('succeeded', 'failed', 'timed_out', 'canceled')) AND "completed_at" IS NULL)
  )
);

CREATE TABLE "workflow_state_transitions" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "stage_id" UUID,
  "attempt_id" UUID,
  "entity_type" "workflow_entity_type" NOT NULL,
  "deduplication_key" VARCHAR(191) NOT NULL,
  "from_status" VARCHAR(40),
  "to_status" VARCHAR(40) NOT NULL,
  "reason_code" VARCHAR(100),
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workflow_state_transitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_transitions_to_status_check" CHECK (length(btrim("to_status")) > 0),
  CONSTRAINT "workflow_transitions_deduplication_key_check"
    CHECK (length(btrim("deduplication_key")) > 0),
  CONSTRAINT "workflow_transitions_entity_reference_check" CHECK (
    ("entity_type" = 'job' AND "stage_id" IS NULL AND "attempt_id" IS NULL)
    OR
    ("entity_type" = 'stage' AND "stage_id" IS NOT NULL AND "attempt_id" IS NULL)
    OR
    ("entity_type" = 'attempt' AND "stage_id" IS NOT NULL AND "attempt_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "workflow_jobs_org_idempotency_key"
  ON "workflow_jobs" ("organization_id", "idempotency_key");
CREATE UNIQUE INDEX "workflow_jobs_video_kind_pipeline_key"
  ON "workflow_jobs" ("source_video_id", "kind", "pipeline_version");
CREATE INDEX "workflow_jobs_org_created_idx"
  ON "workflow_jobs" ("organization_id", "created_at" DESC, "id" DESC);
CREATE INDEX "workflow_jobs_project_created_idx"
  ON "workflow_jobs" ("project_id", "created_at" DESC, "id" DESC);
CREATE INDEX "workflow_jobs_source_video_id_idx" ON "workflow_jobs" ("source_video_id");
CREATE INDEX "workflow_jobs_created_by_user_id_idx" ON "workflow_jobs" ("created_by_user_id");
CREATE INDEX "workflow_jobs_status_updated_idx"
  ON "workflow_jobs" ("status", "updated_at", "id");
CREATE INDEX "workflow_jobs_active_idx"
  ON "workflow_jobs" ("updated_at", "id")
  WHERE "status" IN ('queued', 'running', 'cancel_requested');

CREATE UNIQUE INDEX "workflow_stages_job_key_key" ON "workflow_stages" ("job_id", "key");
CREATE UNIQUE INDEX "workflow_stages_job_ordinal_key"
  ON "workflow_stages" ("job_id", "ordinal");
CREATE INDEX "workflow_stages_status_ready_idx"
  ON "workflow_stages" ("status", "ready_at", "id");
CREATE INDEX "workflow_stages_runnable_idx"
  ON "workflow_stages" ("ready_at", "id")
  WHERE "status" IN ('queued', 'retry_wait');

CREATE UNIQUE INDEX "workflow_attempts_command_idempotency_key"
  ON "workflow_stage_attempts" ("command_idempotency_key");
CREATE UNIQUE INDEX "workflow_attempts_stage_attempt_key"
  ON "workflow_stage_attempts" ("stage_id", "attempt_number");
CREATE INDEX "workflow_attempts_status_lease_idx"
  ON "workflow_stage_attempts" ("status", "leased_until", "id");
CREATE INDEX "workflow_attempts_expired_lease_idx"
  ON "workflow_stage_attempts" ("leased_until", "id")
  WHERE "status" = 'running';

CREATE INDEX "workflow_transitions_job_occurred_idx"
  ON "workflow_state_transitions" ("job_id", "occurred_at", "id");
CREATE INDEX "workflow_transitions_stage_id_idx"
  ON "workflow_state_transitions" ("stage_id");
CREATE INDEX "workflow_transitions_attempt_id_idx"
  ON "workflow_state_transitions" ("attempt_id");
CREATE UNIQUE INDEX "workflow_transitions_deduplication_key"
  ON "workflow_state_transitions" ("deduplication_key");

ALTER TABLE "workflow_jobs"
  ADD CONSTRAINT "workflow_jobs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_jobs"
  ADD CONSTRAINT "workflow_jobs_project_id_organization_id_fkey"
  FOREIGN KEY ("project_id", "organization_id")
  REFERENCES "projects" ("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_jobs"
  ADD CONSTRAINT "workflow_jobs_source_video_id_project_id_organization_id_fkey"
  FOREIGN KEY ("source_video_id", "project_id", "organization_id")
  REFERENCES "videos" ("id", "project_id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_jobs"
  ADD CONSTRAINT "workflow_jobs_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_stages"
  ADD CONSTRAINT "workflow_stages_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "workflow_jobs" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_stage_attempts"
  ADD CONSTRAINT "workflow_stage_attempts_stage_id_fkey"
  FOREIGN KEY ("stage_id") REFERENCES "workflow_stages" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_state_transitions"
  ADD CONSTRAINT "workflow_state_transitions_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "workflow_jobs" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_state_transitions"
  ADD CONSTRAINT "workflow_state_transitions_stage_id_fkey"
  FOREIGN KEY ("stage_id") REFERENCES "workflow_stages" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_state_transitions"
  ADD CONSTRAINT "workflow_state_transitions_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "workflow_stage_attempts" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "media_artifacts" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "producer_attempt_id" UUID NOT NULL,
  "kind" "media_artifact_kind" NOT NULL,
  "media_type" VARCHAR(127) NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "storage_bucket" VARCHAR(255) NOT NULL,
  "storage_key" TEXT NOT NULL,
  "storage_etag" VARCHAR(512),
  "producer_name" VARCHAR(100) NOT NULL,
  "producer_version" VARCHAR(100) NOT NULL,
  "configuration_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_artifacts_byte_size_check" CHECK ("byte_size" > 0),
  CONSTRAINT "media_artifacts_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_artifacts_configuration_hash_check"
    CHECK ("configuration_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "media_artifacts_storage_key_check" CHECK (length("storage_key") > 0)
);

CREATE TABLE "media_audio_artifacts" (
  "artifact_id" UUID NOT NULL,
  "codec_name" VARCHAR(40) NOT NULL,
  "sample_rate_hz" INTEGER NOT NULL,
  "channels" INTEGER NOT NULL,
  "channel_layout" VARCHAR(80),
  "duration_ms" BIGINT NOT NULL,
  "bit_depth" INTEGER,

  CONSTRAINT "media_audio_artifacts_pkey" PRIMARY KEY ("artifact_id"),
  CONSTRAINT "media_audio_artifacts_sample_rate_check" CHECK ("sample_rate_hz" > 0),
  CONSTRAINT "media_audio_artifacts_channels_check" CHECK ("channels" > 0),
  CONSTRAINT "media_audio_artifacts_duration_check" CHECK ("duration_ms" >= 0),
  CONSTRAINT "media_audio_artifacts_bit_depth_check" CHECK ("bit_depth" IS NULL OR "bit_depth" > 0)
);

CREATE TABLE "artifact_lineage" (
  "id" UUID NOT NULL,
  "output_artifact_id" UUID NOT NULL,
  "input_artifact_id" UUID,
  "input_video_id" UUID,
  "role" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "artifact_lineage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_lineage_exactly_one_input_check" CHECK (
    ("input_artifact_id" IS NOT NULL) <> ("input_video_id" IS NOT NULL)
  ),
  CONSTRAINT "artifact_lineage_not_self_check" CHECK (
    "input_artifact_id" IS NULL OR "input_artifact_id" <> "output_artifact_id"
  ),
  CONSTRAINT "artifact_lineage_role_check" CHECK (length(btrim("role")) > 0)
);

CREATE TABLE "media_probes" (
  "id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "manifest_artifact_id" UUID NOT NULL,
  "contract_version" INTEGER NOT NULL,
  "ffprobe_version" VARCHAR(100) NOT NULL,
  "format_name" VARCHAR(100) NOT NULL,
  "duration_ms" BIGINT NOT NULL,
  "start_time_ms" BIGINT,
  "bit_rate" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_probes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_probes_contract_version_check" CHECK ("contract_version" > 0),
  CONSTRAINT "media_probes_duration_check" CHECK ("duration_ms" >= 0),
  CONSTRAINT "media_probes_bit_rate_check" CHECK ("bit_rate" IS NULL OR "bit_rate" >= 0)
);

CREATE TABLE "media_streams" (
  "id" UUID NOT NULL,
  "probe_id" UUID NOT NULL,
  "stream_index" INTEGER NOT NULL,
  "kind" "media_stream_kind" NOT NULL,
  "codec_name" VARCHAR(80),
  "codec_profile" VARCHAR(100),
  "duration_ms" BIGINT,
  "start_time_ms" BIGINT,
  "bit_rate" BIGINT,
  "time_base_numerator" INTEGER,
  "time_base_denominator" INTEGER,
  "language_tag" VARCHAR(35),
  "default_disposition" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "media_streams_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_streams_index_check" CHECK ("stream_index" >= 0),
  CONSTRAINT "media_streams_duration_check" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
  CONSTRAINT "media_streams_bit_rate_check" CHECK ("bit_rate" IS NULL OR "bit_rate" >= 0),
  CONSTRAINT "media_streams_time_base_check" CHECK (
    ("time_base_numerator" IS NULL AND "time_base_denominator" IS NULL)
    OR
    ("time_base_numerator" IS NOT NULL AND "time_base_denominator" > 0)
  )
);

CREATE TABLE "media_audio_streams" (
  "stream_id" UUID NOT NULL,
  "sample_rate_hz" INTEGER,
  "channels" INTEGER,
  "channel_layout" VARCHAR(80),
  "sample_format" VARCHAR(40),

  CONSTRAINT "media_audio_streams_pkey" PRIMARY KEY ("stream_id"),
  CONSTRAINT "media_audio_streams_sample_rate_check"
    CHECK ("sample_rate_hz" IS NULL OR "sample_rate_hz" > 0),
  CONSTRAINT "media_audio_streams_channels_check"
    CHECK ("channels" IS NULL OR "channels" > 0)
);

CREATE TABLE "media_video_streams" (
  "stream_id" UUID NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "frame_rate_numerator" INTEGER,
  "frame_rate_denominator" INTEGER,
  "pixel_format" VARCHAR(80),
  "rotation_degrees" INTEGER,

  CONSTRAINT "media_video_streams_pkey" PRIMARY KEY ("stream_id"),
  CONSTRAINT "media_video_streams_dimensions_check" CHECK (
    ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
  ),
  CONSTRAINT "media_video_streams_frame_rate_check" CHECK (
    ("frame_rate_numerator" IS NULL AND "frame_rate_denominator" IS NULL)
    OR
    ("frame_rate_numerator" >= 0 AND "frame_rate_denominator" > 0)
  )
);

CREATE TABLE "media_track_selections" (
  "id" UUID NOT NULL,
  "probe_id" UUID NOT NULL,
  "stream_id" UUID NOT NULL,
  "role" "media_track_role" NOT NULL,
  "selection_method" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_track_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_track_selections_method_check"
    CHECK (length(btrim("selection_method")) > 0)
);

CREATE UNIQUE INDEX "media_artifacts_storage_location_key"
  ON "media_artifacts" ("storage_bucket", "storage_key");
CREATE UNIQUE INDEX "media_artifacts_attempt_kind_key"
  ON "media_artifacts" ("producer_attempt_id", "kind");
CREATE INDEX "media_artifacts_org_created_idx"
  ON "media_artifacts" ("organization_id", "created_at" DESC, "id" DESC);
CREATE INDEX "media_artifacts_project_kind_created_idx"
  ON "media_artifacts" ("project_id", "kind", "created_at" DESC);
CREATE INDEX "media_artifacts_source_video_id_idx" ON "media_artifacts" ("source_video_id");

CREATE UNIQUE INDEX "artifact_lineage_artifact_role_key"
  ON "artifact_lineage" ("output_artifact_id", "input_artifact_id", "role");
CREATE UNIQUE INDEX "artifact_lineage_video_role_key"
  ON "artifact_lineage" ("output_artifact_id", "input_video_id", "role");
CREATE INDEX "artifact_lineage_input_artifact_idx"
  ON "artifact_lineage" ("input_artifact_id");
CREATE INDEX "artifact_lineage_input_video_idx" ON "artifact_lineage" ("input_video_id");

CREATE UNIQUE INDEX "media_probes_manifest_artifact_key"
  ON "media_probes" ("manifest_artifact_id");
CREATE UNIQUE INDEX "media_probes_video_attempt_key"
  ON "media_probes" ("source_video_id", "attempt_id");
CREATE INDEX "media_probes_attempt_id_idx" ON "media_probes" ("attempt_id");

CREATE UNIQUE INDEX "media_streams_probe_stream_index_key"
  ON "media_streams" ("probe_id", "stream_index");
CREATE UNIQUE INDEX "media_streams_id_probe_key" ON "media_streams" ("id", "probe_id");
CREATE UNIQUE INDEX "media_track_selections_probe_role_key"
  ON "media_track_selections" ("probe_id", "role");
CREATE INDEX "media_track_selections_stream_id_idx"
  ON "media_track_selections" ("stream_id");

ALTER TABLE "media_artifacts"
  ADD CONSTRAINT "media_artifacts_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifacts"
  ADD CONSTRAINT "media_artifacts_project_id_organization_id_fkey"
  FOREIGN KEY ("project_id", "organization_id")
  REFERENCES "projects" ("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifacts"
  ADD CONSTRAINT "media_artifacts_source_video_id_project_id_organization_id_fkey"
  FOREIGN KEY ("source_video_id", "project_id", "organization_id")
  REFERENCES "videos" ("id", "project_id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifacts"
  ADD CONSTRAINT "media_artifacts_producer_attempt_id_fkey"
  FOREIGN KEY ("producer_attempt_id") REFERENCES "workflow_stage_attempts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_audio_artifacts"
  ADD CONSTRAINT "media_audio_artifacts_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "media_artifacts" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "artifact_lineage"
  ADD CONSTRAINT "artifact_lineage_output_artifact_id_fkey"
  FOREIGN KEY ("output_artifact_id") REFERENCES "media_artifacts" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "artifact_lineage"
  ADD CONSTRAINT "artifact_lineage_input_artifact_id_fkey"
  FOREIGN KEY ("input_artifact_id") REFERENCES "media_artifacts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "artifact_lineage"
  ADD CONSTRAINT "artifact_lineage_input_video_id_fkey"
  FOREIGN KEY ("input_video_id") REFERENCES "videos" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_probes"
  ADD CONSTRAINT "media_probes_source_video_id_fkey"
  FOREIGN KEY ("source_video_id") REFERENCES "videos" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_probes"
  ADD CONSTRAINT "media_probes_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "workflow_stage_attempts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_probes"
  ADD CONSTRAINT "media_probes_manifest_artifact_id_fkey"
  FOREIGN KEY ("manifest_artifact_id") REFERENCES "media_artifacts" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_streams"
  ADD CONSTRAINT "media_streams_probe_id_fkey"
  FOREIGN KEY ("probe_id") REFERENCES "media_probes" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_audio_streams"
  ADD CONSTRAINT "media_audio_streams_stream_id_fkey"
  FOREIGN KEY ("stream_id") REFERENCES "media_streams" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_video_streams"
  ADD CONSTRAINT "media_video_streams_stream_id_fkey"
  FOREIGN KEY ("stream_id") REFERENCES "media_streams" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_track_selections"
  ADD CONSTRAINT "media_track_selections_probe_id_fkey"
  FOREIGN KEY ("probe_id") REFERENCES "media_probes" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_track_selections"
  ADD CONSTRAINT "media_track_selections_stream_id_probe_id_fkey"
  FOREIGN KEY ("stream_id", "probe_id") REFERENCES "media_streams" ("id", "probe_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Supabase is private PostgreSQL for VoiceVerse. New tables must not become browser
-- Data API surfaces even if a role grant is later introduced outside migrations.
DO $voiceverse$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE workflow_jobs, workflow_stages, workflow_stage_attempts, workflow_state_transitions, media_artifacts, media_audio_artifacts, artifact_lineage, media_probes, media_streams, media_audio_streams, media_video_streams, media_track_selections FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$voiceverse$;

COMMIT;
