-- Milestone 5 durable speech analysis, character identity, and timed dialogue.
-- Enum extensions are committed by the preceding migration. Everything below is
-- all-or-nothing so failed preflights leave the Milestone 4 schema untouched.
BEGIN;

CREATE TYPE "character_origin" AS ENUM ('detected', 'user_created');
CREATE TYPE "character_status" AS ENUM ('active', 'merged', 'archived');

ALTER TABLE "media_audio_artifacts"
  ADD COLUMN "duration_us" BIGINT,
  ADD CONSTRAINT "media_audio_artifacts_duration_us_check"
    CHECK ("duration_us" IS NULL OR "duration_us" >= 0);

ALTER TABLE "workflow_stages"
  ADD COLUMN "configuration_snapshot" JSONB,
  ADD COLUMN "configuration_hash" CHAR(64),
  ALTER COLUMN "ready_at" DROP NOT NULL;

-- Milestone 4 has exactly one source-preparation stage and always creates attempt
-- one. Copy its already-authoritative hash and materialize the matching non-secret
-- configuration snapshot before making the new columns required.
UPDATE "workflow_stages" AS stage
SET "configuration_hash" = attempt."configuration_hash",
    "configuration_snapshot" = '{"analysisAudio":{"channels":1,"codec":"flac","sampleRateHz":16000},"canonicalAudio":{"codec":"flac","sampleRateHz":48000},"contract":"voiceverse.media-preparation.v1","pipeline":"source-preparation-v1"}'::jsonb
FROM "workflow_stage_attempts" AS attempt
WHERE attempt."stage_id" = stage."id"
  AND attempt."attempt_number" = 1
  AND stage."kind" = 'source_media_preparation';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "workflow_stages"
    WHERE "configuration_snapshot" IS NULL OR "configuration_hash" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Milestone 5 preflight failed: a workflow stage has no reproducible configuration',
      HINT = 'Repair the stage and its first attempt before deploying this migration.';
  END IF;
END
$$;

ALTER TABLE "workflow_stages"
  ALTER COLUMN "configuration_snapshot" SET NOT NULL,
  ALTER COLUMN "configuration_hash" SET NOT NULL,
  ADD CONSTRAINT "workflow_stages_configuration_hash_check"
    CHECK ("configuration_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "workflow_stages_blocked_state_check" CHECK (
    "status" <> 'blocked'
    OR (
      "ready_at" IS NULL
      AND "started_at" IS NULL
      AND "completed_at" IS NULL
      AND "progress_basis_points" = 0
    )
  ),
  ADD CONSTRAINT "workflow_stages_runnable_ready_at_check" CHECK (
    "status" NOT IN ('queued', 'retry_wait') OR "ready_at" IS NOT NULL
  ),
  ADD CONSTRAINT "workflow_stages_running_started_at_check" CHECK (
    "status" <> 'running' OR "started_at" IS NOT NULL
  );

CREATE UNIQUE INDEX "workflow_jobs_id_tenant_source_key"
  ON "workflow_jobs" ("id", "organization_id", "project_id", "source_video_id");
CREATE UNIQUE INDEX "workflow_stages_id_job_key"
  ON "workflow_stages" ("id", "job_id");
CREATE INDEX "workflow_stages_blocked_idx"
  ON "workflow_stages" ("job_id", "ordinal", "id")
  WHERE "status" = 'blocked';

CREATE TABLE "workflow_stage_dependencies" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "depends_on_stage_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workflow_stage_dependencies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_stage_dependencies_not_self_check"
    CHECK ("stage_id" <> "depends_on_stage_id")
);

CREATE TABLE "workflow_job_artifact_inputs" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "role" VARCHAR(80) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workflow_job_artifact_inputs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_job_artifact_inputs_role_check"
    CHECK (length(btrim("role")) > 0)
);

CREATE UNIQUE INDEX "media_artifacts_id_tenant_source_key"
  ON "media_artifacts" ("id", "organization_id", "project_id", "source_video_id");

ALTER TABLE "artifact_lineage"
  ADD COLUMN "organization_id" UUID,
  ADD COLUMN "project_id" UUID,
  ADD COLUMN "source_video_id" UUID;

UPDATE "artifact_lineage" AS lineage
SET "organization_id" = output."organization_id",
    "project_id" = output."project_id",
    "source_video_id" = output."source_video_id"
FROM "media_artifacts" AS output
WHERE output."id" = lineage."output_artifact_id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "artifact_lineage" AS lineage
    LEFT JOIN "media_artifacts" AS output
      ON output."id" = lineage."output_artifact_id"
    LEFT JOIN "media_artifacts" AS input
      ON input."id" = lineage."input_artifact_id"
    LEFT JOIN "videos" AS input_video
      ON input_video."id" = lineage."input_video_id"
    WHERE output."id" IS NULL
       OR (
         input."id" IS NOT NULL
         AND (
           input."organization_id" <> output."organization_id"
           OR input."project_id" <> output."project_id"
           OR input."source_video_id" <> output."source_video_id"
         )
       )
       OR (
         input_video."id" IS NOT NULL
         AND (
           input_video."organization_id" <> output."organization_id"
           OR input_video."project_id" <> output."project_id"
           OR input_video."id" <> output."source_video_id"
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Milestone 5 preflight failed: artifact lineage crosses a tenant, project, or source video',
      HINT = 'Repair the invalid lineage edge before deploying this migration.';
  END IF;
END
$$;

ALTER TABLE "artifact_lineage"
  ALTER COLUMN "organization_id" SET NOT NULL,
  ALTER COLUMN "project_id" SET NOT NULL,
  ALTER COLUMN "source_video_id" SET NOT NULL,
  DROP CONSTRAINT "artifact_lineage_output_artifact_id_fkey",
  DROP CONSTRAINT "artifact_lineage_input_artifact_id_fkey",
  DROP CONSTRAINT "artifact_lineage_input_video_id_fkey";

CREATE TABLE "speech_analyses" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "workflow_job_id" UUID NOT NULL,
  "source_language_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "speech_analyses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transcription_runs" (
  "id" UUID NOT NULL,
  "speech_analysis_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "producer_attempt_id" UUID NOT NULL,
  "input_artifact_id" UUID NOT NULL,
  "manifest_artifact_id" UUID NOT NULL,
  "source_language_id" UUID NOT NULL,
  "contract_version" INTEGER NOT NULL,
  "provider_name" VARCHAR(100) NOT NULL,
  "model_name" VARCHAR(160) NOT NULL,
  "model_revision" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transcription_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transcription_runs_contract_version_check" CHECK ("contract_version" > 0),
  CONSTRAINT "transcription_runs_provider_name_check" CHECK (length(btrim("provider_name")) > 0),
  CONSTRAINT "transcription_runs_model_name_check" CHECK (length(btrim("model_name")) > 0),
  CONSTRAINT "transcription_runs_model_revision_check" CHECK (length(btrim("model_revision")) > 0),
  CONSTRAINT "transcription_runs_distinct_artifacts_check"
    CHECK ("input_artifact_id" <> "manifest_artifact_id")
);

CREATE TABLE "transcript_segments" (
  "id" UUID NOT NULL,
  "transcription_run_id" UUID NOT NULL,
  "sequence_number" INTEGER NOT NULL,
  "start_time_us" BIGINT NOT NULL,
  "end_time_us" BIGINT NOT NULL,
  "text" TEXT NOT NULL,
  "language_tag" VARCHAR(35),
  "confidence_basis_points" INTEGER,
  "no_speech_probability_basis_points" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transcript_segments_sequence_check" CHECK ("sequence_number" >= 0),
  CONSTRAINT "transcript_segments_time_range_check"
    CHECK ("start_time_us" >= 0 AND "end_time_us" > "start_time_us"),
  CONSTRAINT "transcript_segments_text_check" CHECK (length(btrim("text")) > 0),
  CONSTRAINT "transcript_segments_language_tag_check"
    CHECK ("language_tag" IS NULL OR length(btrim("language_tag")) > 0),
  CONSTRAINT "transcript_segments_confidence_check"
    CHECK ("confidence_basis_points" IS NULL OR "confidence_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "transcript_segments_no_speech_check"
    CHECK ("no_speech_probability_basis_points" IS NULL OR "no_speech_probability_basis_points" BETWEEN 0 AND 10000)
);

CREATE TABLE "transcript_words" (
  "id" UUID NOT NULL,
  "transcription_run_id" UUID NOT NULL,
  "transcript_segment_id" UUID NOT NULL,
  "sequence_number" INTEGER NOT NULL,
  "start_time_us" BIGINT NOT NULL,
  "end_time_us" BIGINT NOT NULL,
  "text" TEXT NOT NULL,
  "confidence_basis_points" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "transcript_words_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transcript_words_sequence_check" CHECK ("sequence_number" >= 0),
  CONSTRAINT "transcript_words_time_range_check"
    CHECK ("start_time_us" >= 0 AND "end_time_us" > "start_time_us"),
  CONSTRAINT "transcript_words_text_check" CHECK (length(btrim("text")) > 0),
  CONSTRAINT "transcript_words_confidence_check"
    CHECK ("confidence_basis_points" IS NULL OR "confidence_basis_points" BETWEEN 0 AND 10000)
);

CREATE TABLE "diarization_runs" (
  "id" UUID NOT NULL,
  "speech_analysis_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "producer_attempt_id" UUID NOT NULL,
  "input_artifact_id" UUID NOT NULL,
  "manifest_artifact_id" UUID NOT NULL,
  "contract_version" INTEGER NOT NULL,
  "provider_name" VARCHAR(100) NOT NULL,
  "model_name" VARCHAR(160) NOT NULL,
  "model_revision" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "diarization_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "diarization_runs_contract_version_check" CHECK ("contract_version" > 0),
  CONSTRAINT "diarization_runs_provider_name_check" CHECK (length(btrim("provider_name")) > 0),
  CONSTRAINT "diarization_runs_model_name_check" CHECK (length(btrim("model_name")) > 0),
  CONSTRAINT "diarization_runs_model_revision_check" CHECK (length(btrim("model_revision")) > 0),
  CONSTRAINT "diarization_runs_distinct_artifacts_check"
    CHECK ("input_artifact_id" <> "manifest_artifact_id")
);

CREATE TABLE "speaker_clusters" (
  "id" UUID NOT NULL,
  "diarization_run_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "provider_label" VARCHAR(100) NOT NULL,
  "confidence_basis_points" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "speaker_clusters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "speaker_clusters_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "speaker_clusters_provider_label_check" CHECK (length(btrim("provider_label")) > 0),
  CONSTRAINT "speaker_clusters_confidence_check"
    CHECK ("confidence_basis_points" IS NULL OR "confidence_basis_points" BETWEEN 0 AND 10000)
);

CREATE TABLE "speaker_turns" (
  "id" UUID NOT NULL,
  "diarization_run_id" UUID NOT NULL,
  "speaker_cluster_id" UUID NOT NULL,
  "is_exclusive" BOOLEAN NOT NULL DEFAULT false,
  "sequence_number" INTEGER NOT NULL,
  "start_time_us" BIGINT NOT NULL,
  "end_time_us" BIGINT NOT NULL,
  "has_overlap" BOOLEAN NOT NULL DEFAULT false,
  "confidence_basis_points" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "speaker_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "speaker_turns_sequence_check" CHECK ("sequence_number" >= 0),
  CONSTRAINT "speaker_turns_time_range_check"
    CHECK ("start_time_us" >= 0 AND "end_time_us" > "start_time_us"),
  CONSTRAINT "speaker_turns_confidence_check"
    CHECK ("confidence_basis_points" IS NULL OR "confidence_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "speaker_turns_exclusive_overlap_check"
    CHECK (NOT "is_exclusive" OR NOT "has_overlap")
);

CREATE TABLE "characters" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "stable_key" VARCHAR(100) NOT NULL,
  "display_name" VARCHAR(160),
  "origin" "character_origin" NOT NULL DEFAULT 'detected',
  "status" "character_status" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "characters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "characters_stable_key_check" CHECK (length(btrim("stable_key")) > 0),
  CONSTRAINT "characters_display_name_check"
    CHECK ("display_name" IS NULL OR length(btrim("display_name")) > 0)
);

CREATE TABLE "character_identification_runs" (
  "id" UUID NOT NULL,
  "speech_analysis_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_video_id" UUID NOT NULL,
  "transcription_run_id" UUID NOT NULL,
  "diarization_run_id" UUID NOT NULL,
  "producer_attempt_id" UUID NOT NULL,
  "manifest_artifact_id" UUID NOT NULL,
  "contract_version" INTEGER NOT NULL,
  "resolver_name" VARCHAR(100) NOT NULL,
  "resolver_version" VARCHAR(160) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "character_identification_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "character_identification_runs_contract_version_check" CHECK ("contract_version" > 0),
  CONSTRAINT "character_identification_runs_resolver_name_check" CHECK (length(btrim("resolver_name")) > 0),
  CONSTRAINT "character_identification_runs_resolver_version_check" CHECK (length(btrim("resolver_version")) > 0)
);

CREATE TABLE "speaker_character_assignments" (
  "id" UUID NOT NULL,
  "character_identification_run_id" UUID NOT NULL,
  "diarization_run_id" UUID NOT NULL,
  "speaker_cluster_id" UUID NOT NULL,
  "character_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "confidence_basis_points" INTEGER,
  "assignment_method" VARCHAR(80) NOT NULL,
  "first_appearance_time_us" BIGINT NOT NULL,
  "speaking_duration_us" BIGINT NOT NULL DEFAULT 0,
  "segment_count" INTEGER NOT NULL DEFAULT 0,
  "word_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "speaker_character_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "speaker_character_assignments_confidence_check"
    CHECK ("confidence_basis_points" IS NULL OR "confidence_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "speaker_character_assignments_method_check"
    CHECK (length(btrim("assignment_method")) > 0),
  CONSTRAINT "speaker_character_assignments_statistics_check" CHECK (
    "first_appearance_time_us" >= 0
    AND "speaking_duration_us" >= 0
    AND "segment_count" >= 0
    AND "word_count" >= 0
  )
);

CREATE TABLE "dialogue_segments" (
  "id" UUID NOT NULL,
  "character_identification_run_id" UUID NOT NULL,
  "speech_analysis_id" UUID NOT NULL,
  "transcription_run_id" UUID NOT NULL,
  "diarization_run_id" UUID NOT NULL,
  "speaker_assignment_id" UUID,
  "transcript_segment_id" UUID NOT NULL,
  "speaker_turn_id" UUID,
  "speaker_turn_is_exclusive" BOOLEAN,
  "sequence_number" INTEGER NOT NULL,
  "start_time_us" BIGINT NOT NULL,
  "end_time_us" BIGINT NOT NULL,
  "text" TEXT NOT NULL,
  "source_word_start_sequence" INTEGER,
  "source_word_end_sequence" INTEGER,
  "assignment_method" VARCHAR(80) NOT NULL,
  "assignment_confidence_basis_points" INTEGER,
  "transcription_confidence_basis_points" INTEGER,
  "is_overlapping" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dialogue_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dialogue_segments_sequence_check" CHECK ("sequence_number" >= 0),
  CONSTRAINT "dialogue_segments_time_range_check"
    CHECK ("start_time_us" >= 0 AND "end_time_us" > "start_time_us"),
  CONSTRAINT "dialogue_segments_text_check" CHECK (length(btrim("text")) > 0),
  CONSTRAINT "dialogue_segments_assignment_method_check"
    CHECK (length(btrim("assignment_method")) > 0),
  CONSTRAINT "dialogue_segments_assignment_confidence_check"
    CHECK ("assignment_confidence_basis_points" IS NULL OR "assignment_confidence_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "dialogue_segments_transcription_confidence_check"
    CHECK ("transcription_confidence_basis_points" IS NULL OR "transcription_confidence_basis_points" BETWEEN 0 AND 10000),
  CONSTRAINT "dialogue_segments_word_range_check" CHECK (
    ("source_word_start_sequence" IS NULL AND "source_word_end_sequence" IS NULL)
    OR (
      "source_word_start_sequence" >= 0
      AND "source_word_end_sequence" >= "source_word_start_sequence"
    )
  ),
  CONSTRAINT "dialogue_segments_speaker_turn_state_check" CHECK (
    ("speaker_turn_id" IS NULL AND "speaker_turn_is_exclusive" IS NULL)
    OR ("speaker_turn_id" IS NOT NULL AND "speaker_turn_is_exclusive" IS TRUE)
  )
);

CREATE TABLE "project_speech_analysis_selections" (
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "speech_analysis_id" UUID NOT NULL,
  "selected_by_user_id" UUID,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "project_speech_analysis_selections_pkey"
    PRIMARY KEY ("organization_id", "project_id"),
  CONSTRAINT "project_speech_analysis_selections_revision_check" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "workflow_stage_dependencies_stage_dependency_key"
  ON "workflow_stage_dependencies" ("stage_id", "depends_on_stage_id");
CREATE INDEX "workflow_stage_dependencies_depends_on_idx"
  ON "workflow_stage_dependencies" ("depends_on_stage_id", "stage_id");
CREATE INDEX "workflow_stage_dependencies_job_id_idx"
  ON "workflow_stage_dependencies" ("job_id");
CREATE UNIQUE INDEX "workflow_job_artifact_inputs_job_role_key"
  ON "workflow_job_artifact_inputs" ("job_id", "role");
CREATE INDEX "workflow_job_artifact_inputs_artifact_id_idx"
  ON "workflow_job_artifact_inputs" ("artifact_id");

CREATE UNIQUE INDEX "speech_analyses_workflow_job_key" ON "speech_analyses" ("workflow_job_id");
CREATE UNIQUE INDEX "speech_analyses_id_tenant_project_key"
  ON "speech_analyses" ("id", "organization_id", "project_id");
CREATE UNIQUE INDEX "speech_analyses_id_tenant_source_key"
  ON "speech_analyses" ("id", "organization_id", "project_id", "source_video_id");
CREATE UNIQUE INDEX "speech_analyses_job_tenant_source_key"
  ON "speech_analyses" ("workflow_job_id", "organization_id", "project_id", "source_video_id");
CREATE INDEX "speech_analyses_org_project_created_idx"
  ON "speech_analyses" ("organization_id", "project_id", "created_at" DESC, "id" DESC);
CREATE INDEX "speech_analyses_project_tenant_idx"
  ON "speech_analyses" ("project_id", "organization_id");
CREATE INDEX "speech_analyses_source_video_id_idx" ON "speech_analyses" ("source_video_id");
CREATE INDEX "speech_analyses_source_language_id_idx" ON "speech_analyses" ("source_language_id");

CREATE UNIQUE INDEX "transcription_runs_analysis_key" ON "transcription_runs" ("speech_analysis_id");
CREATE UNIQUE INDEX "transcription_runs_producer_attempt_key" ON "transcription_runs" ("producer_attempt_id");
CREATE UNIQUE INDEX "transcription_runs_manifest_artifact_key" ON "transcription_runs" ("manifest_artifact_id");
CREATE UNIQUE INDEX "transcription_runs_id_analysis_key"
  ON "transcription_runs" ("id", "speech_analysis_id");
CREATE UNIQUE INDEX "transcription_runs_analysis_tenant_source_key"
  ON "transcription_runs" ("speech_analysis_id", "organization_id", "project_id", "source_video_id");
CREATE INDEX "transcription_runs_input_artifact_id_idx" ON "transcription_runs" ("input_artifact_id");
CREATE INDEX "transcription_runs_source_language_id_idx" ON "transcription_runs" ("source_language_id");

CREATE UNIQUE INDEX "transcript_segments_run_sequence_key"
  ON "transcript_segments" ("transcription_run_id", "sequence_number");
CREATE UNIQUE INDEX "transcript_segments_id_run_key"
  ON "transcript_segments" ("id", "transcription_run_id");
CREATE INDEX "transcript_segments_run_start_idx"
  ON "transcript_segments" ("transcription_run_id", "start_time_us", "id");
CREATE UNIQUE INDEX "transcript_words_segment_sequence_key"
  ON "transcript_words" ("transcript_segment_id", "sequence_number");
CREATE INDEX "transcript_words_run_start_idx"
  ON "transcript_words" ("transcription_run_id", "start_time_us", "id");

CREATE UNIQUE INDEX "diarization_runs_analysis_key" ON "diarization_runs" ("speech_analysis_id");
CREATE UNIQUE INDEX "diarization_runs_producer_attempt_key" ON "diarization_runs" ("producer_attempt_id");
CREATE UNIQUE INDEX "diarization_runs_manifest_artifact_key" ON "diarization_runs" ("manifest_artifact_id");
CREATE UNIQUE INDEX "diarization_runs_id_analysis_key"
  ON "diarization_runs" ("id", "speech_analysis_id");
CREATE UNIQUE INDEX "diarization_runs_analysis_tenant_source_key"
  ON "diarization_runs" ("speech_analysis_id", "organization_id", "project_id", "source_video_id");
CREATE INDEX "diarization_runs_input_artifact_id_idx" ON "diarization_runs" ("input_artifact_id");

CREATE UNIQUE INDEX "speaker_clusters_run_ordinal_key"
  ON "speaker_clusters" ("diarization_run_id", "ordinal");
CREATE UNIQUE INDEX "speaker_clusters_id_run_key"
  ON "speaker_clusters" ("id", "diarization_run_id");
CREATE INDEX "speaker_clusters_run_label_idx"
  ON "speaker_clusters" ("diarization_run_id", "provider_label");
CREATE UNIQUE INDEX "speaker_turns_run_timeline_sequence_key"
  ON "speaker_turns" ("diarization_run_id", "is_exclusive", "sequence_number");
CREATE UNIQUE INDEX "speaker_turns_id_run_timeline_key"
  ON "speaker_turns" ("id", "diarization_run_id", "is_exclusive");
CREATE INDEX "speaker_turns_run_timeline_start_idx"
  ON "speaker_turns" ("diarization_run_id", "is_exclusive", "start_time_us", "id");
CREATE INDEX "speaker_turns_cluster_timeline_start_idx"
  ON "speaker_turns" ("speaker_cluster_id", "is_exclusive", "start_time_us", "id");

CREATE UNIQUE INDEX "characters_project_stable_key" ON "characters" ("project_id", "stable_key");
CREATE UNIQUE INDEX "characters_id_project_organization_key"
  ON "characters" ("id", "project_id", "organization_id");
CREATE INDEX "characters_org_project_created_idx"
  ON "characters" ("organization_id", "project_id", "created_at", "id");

CREATE UNIQUE INDEX "character_identification_runs_analysis_key"
  ON "character_identification_runs" ("speech_analysis_id");
CREATE UNIQUE INDEX "character_identification_runs_producer_attempt_key"
  ON "character_identification_runs" ("producer_attempt_id");
CREATE UNIQUE INDEX "character_identification_runs_manifest_artifact_key"
  ON "character_identification_runs" ("manifest_artifact_id");
CREATE UNIQUE INDEX "character_identification_runs_id_input_runs_key"
  ON "character_identification_runs" ("id", "speech_analysis_id", "transcription_run_id", "diarization_run_id");
CREATE UNIQUE INDEX "character_identification_runs_id_diarization_tenant_key"
  ON "character_identification_runs" ("id", "diarization_run_id", "organization_id", "project_id");
CREATE UNIQUE INDEX "character_identification_runs_analysis_tenant_source_key"
  ON "character_identification_runs" ("speech_analysis_id", "organization_id", "project_id", "source_video_id");
CREATE INDEX "character_identification_runs_transcription_id_idx"
  ON "character_identification_runs" ("transcription_run_id");
CREATE INDEX "character_identification_runs_diarization_id_idx"
  ON "character_identification_runs" ("diarization_run_id");

CREATE UNIQUE INDEX "speaker_character_assignments_run_cluster_key"
  ON "speaker_character_assignments" ("character_identification_run_id", "speaker_cluster_id");
CREATE UNIQUE INDEX "speaker_character_assignments_id_run_key"
  ON "speaker_character_assignments" ("id", "character_identification_run_id");
CREATE INDEX "speaker_character_assignments_run_first_appearance_idx"
  ON "speaker_character_assignments" ("character_identification_run_id", "first_appearance_time_us", "id");
CREATE INDEX "speaker_character_assignments_cluster_id_idx"
  ON "speaker_character_assignments" ("speaker_cluster_id");
CREATE INDEX "speaker_character_assignments_character_created_idx"
  ON "speaker_character_assignments" ("character_id", "created_at", "id");

CREATE UNIQUE INDEX "dialogue_segments_run_sequence_key"
  ON "dialogue_segments" ("character_identification_run_id", "sequence_number");
CREATE INDEX "dialogue_segments_run_start_idx"
  ON "dialogue_segments" ("character_identification_run_id", "start_time_us", "id");
CREATE INDEX "dialogue_segments_assignment_start_idx"
  ON "dialogue_segments" ("speaker_assignment_id", "start_time_us", "id");
CREATE INDEX "dialogue_segments_transcript_segment_id_idx"
  ON "dialogue_segments" ("transcript_segment_id");
CREATE INDEX "dialogue_segments_speaker_turn_id_idx" ON "dialogue_segments" ("speaker_turn_id");

CREATE UNIQUE INDEX "project_speech_analysis_selections_analysis_key"
  ON "project_speech_analysis_selections" ("speech_analysis_id");
CREATE UNIQUE INDEX "project_speech_analysis_selections_project_tenant_key"
  ON "project_speech_analysis_selections" ("project_id", "organization_id");
CREATE UNIQUE INDEX "project_speech_analysis_selections_analysis_tenant_key"
  ON "project_speech_analysis_selections" ("speech_analysis_id", "organization_id", "project_id");
CREATE INDEX "project_speech_analysis_selections_selected_by_idx"
  ON "project_speech_analysis_selections" ("selected_by_user_id");

ALTER TABLE "workflow_stage_dependencies"
  ADD CONSTRAINT "workflow_stage_dependencies_stage_id_job_id_fkey"
    FOREIGN KEY ("stage_id", "job_id") REFERENCES "workflow_stages" ("id", "job_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_stage_dependencies_depends_on_stage_id_job_id_fkey"
    FOREIGN KEY ("depends_on_stage_id", "job_id") REFERENCES "workflow_stages" ("id", "job_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_job_artifact_inputs"
  ADD CONSTRAINT "workflow_job_artifact_inputs_job_id_organization_id_projec_fkey"
    FOREIGN KEY ("job_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "workflow_jobs" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "workflow_job_artifact_inputs_artifact_id_organization_id_p_fkey"
    FOREIGN KEY ("artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "artifact_lineage"
  ADD CONSTRAINT "artifact_lineage_output_artifact_id_organization_id_projec_fkey"
    FOREIGN KEY ("output_artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "artifact_lineage_input_artifact_id_organization_id_project_fkey"
    FOREIGN KEY ("input_artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "artifact_lineage_input_video_id_project_id_organization_id_fkey"
    FOREIGN KEY ("input_video_id", "project_id", "organization_id")
    REFERENCES "videos" ("id", "project_id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "speech_analyses"
  ADD CONSTRAINT "speech_analyses_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "speech_analyses_project_id_organization_id_fkey"
    FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects" ("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "speech_analyses_source_video_id_project_id_organization_id_fkey"
    FOREIGN KEY ("source_video_id", "project_id", "organization_id")
    REFERENCES "videos" ("id", "project_id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "speech_analyses_workflow_job_id_organization_id_project_id_fkey"
    FOREIGN KEY ("workflow_job_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "workflow_jobs" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "speech_analyses_source_language_id_fkey"
    FOREIGN KEY ("source_language_id") REFERENCES "languages" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transcription_runs"
  ADD CONSTRAINT "transcription_runs_speech_analysis_id_organization_id_proj_fkey"
    FOREIGN KEY ("speech_analysis_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "speech_analyses" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "transcription_runs_producer_attempt_id_fkey"
    FOREIGN KEY ("producer_attempt_id") REFERENCES "workflow_stage_attempts" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "transcription_runs_input_artifact_id_organization_id_proje_fkey"
    FOREIGN KEY ("input_artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "transcription_runs_manifest_artifact_id_organization_id_pr_fkey"
    FOREIGN KEY ("manifest_artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "transcription_runs_source_language_id_fkey"
    FOREIGN KEY ("source_language_id") REFERENCES "languages" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transcript_segments"
  ADD CONSTRAINT "transcript_segments_transcription_run_id_fkey"
    FOREIGN KEY ("transcription_run_id") REFERENCES "transcription_runs" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transcript_words"
  ADD CONSTRAINT "transcript_words_transcript_segment_id_transcription_run_i_fkey"
    FOREIGN KEY ("transcript_segment_id", "transcription_run_id")
    REFERENCES "transcript_segments" ("id", "transcription_run_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "diarization_runs"
  ADD CONSTRAINT "diarization_runs_speech_analysis_id_organization_id_projec_fkey"
    FOREIGN KEY ("speech_analysis_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "speech_analyses" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "diarization_runs_producer_attempt_id_fkey"
    FOREIGN KEY ("producer_attempt_id") REFERENCES "workflow_stage_attempts" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "diarization_runs_input_artifact_id_organization_id_project_fkey"
    FOREIGN KEY ("input_artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "diarization_runs_manifest_artifact_id_organization_id_proj_fkey"
    FOREIGN KEY ("manifest_artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "speaker_clusters"
  ADD CONSTRAINT "speaker_clusters_diarization_run_id_fkey"
    FOREIGN KEY ("diarization_run_id") REFERENCES "diarization_runs" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speaker_turns"
  ADD CONSTRAINT "speaker_turns_speaker_cluster_id_diarization_run_id_fkey"
    FOREIGN KEY ("speaker_cluster_id", "diarization_run_id")
    REFERENCES "speaker_clusters" ("id", "diarization_run_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "characters"
  ADD CONSTRAINT "characters_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "characters_project_id_organization_id_fkey"
    FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects" ("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "character_identification_runs"
  ADD CONSTRAINT "character_identification_runs_speech_analysis_id_organizat_fkey"
    FOREIGN KEY ("speech_analysis_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "speech_analyses" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "character_identification_runs_transcription_run_id_speech__fkey"
    FOREIGN KEY ("transcription_run_id", "speech_analysis_id")
    REFERENCES "transcription_runs" ("id", "speech_analysis_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "character_identification_runs_diarization_run_id_speech_an_fkey"
    FOREIGN KEY ("diarization_run_id", "speech_analysis_id")
    REFERENCES "diarization_runs" ("id", "speech_analysis_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "character_identification_runs_producer_attempt_id_fkey"
    FOREIGN KEY ("producer_attempt_id") REFERENCES "workflow_stage_attempts" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "character_identification_runs_manifest_artifact_id_organiz_fkey"
    FOREIGN KEY ("manifest_artifact_id", "organization_id", "project_id", "source_video_id")
    REFERENCES "media_artifacts" ("id", "organization_id", "project_id", "source_video_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "speaker_character_assignments"
  ADD CONSTRAINT "speaker_character_assignments_character_identification_run_fkey"
    FOREIGN KEY ("character_identification_run_id", "diarization_run_id", "organization_id", "project_id")
    REFERENCES "character_identification_runs" ("id", "diarization_run_id", "organization_id", "project_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "speaker_character_assignments_speaker_cluster_id_diarizati_fkey"
    FOREIGN KEY ("speaker_cluster_id", "diarization_run_id")
    REFERENCES "speaker_clusters" ("id", "diarization_run_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "speaker_character_assignments_character_id_project_id_orga_fkey"
    FOREIGN KEY ("character_id", "project_id", "organization_id")
    REFERENCES "characters" ("id", "project_id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dialogue_segments"
  ADD CONSTRAINT "dialogue_segments_character_identification_run_id_speech_a_fkey"
    FOREIGN KEY ("character_identification_run_id", "speech_analysis_id", "transcription_run_id", "diarization_run_id")
    REFERENCES "character_identification_runs" ("id", "speech_analysis_id", "transcription_run_id", "diarization_run_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "dialogue_segments_speaker_assignment_id_character_identifi_fkey"
    FOREIGN KEY ("speaker_assignment_id", "character_identification_run_id")
    REFERENCES "speaker_character_assignments" ("id", "character_identification_run_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "dialogue_segments_transcript_segment_id_transcription_run__fkey"
    FOREIGN KEY ("transcript_segment_id", "transcription_run_id")
    REFERENCES "transcript_segments" ("id", "transcription_run_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "dialogue_segments_speaker_turn_id_diarization_run_id_speak_fkey"
    FOREIGN KEY ("speaker_turn_id", "diarization_run_id", "speaker_turn_is_exclusive")
    REFERENCES "speaker_turns" ("id", "diarization_run_id", "is_exclusive")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_speech_analysis_selections"
  ADD CONSTRAINT "project_speech_analysis_selections_project_id_organization_fkey"
    FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects" ("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_speech_analysis_selections_speech_analysis_id_orga_fkey"
    FOREIGN KEY ("speech_analysis_id", "organization_id", "project_id")
    REFERENCES "speech_analyses" ("id", "organization_id", "project_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_speech_analysis_selections_organization_id_selecte_fkey"
    FOREIGN KEY ("organization_id", "selected_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Supabase is private PostgreSQL for VoiceVerse. These confidential transcript,
-- speaker, and character tables are never browser Data API surfaces.
DO $voiceverse$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE workflow_stage_dependencies, workflow_job_artifact_inputs, speech_analyses, transcription_runs, transcript_segments, transcript_words, diarization_runs, speaker_clusters, speaker_turns, characters, character_identification_runs, speaker_character_assignments, dialogue_segments, project_speech_analysis_selections FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$voiceverse$;

COMMIT;
