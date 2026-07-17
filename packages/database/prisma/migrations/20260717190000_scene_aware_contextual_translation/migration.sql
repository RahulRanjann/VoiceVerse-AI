-- Milestone 6 scene-aware contextual translation and append-only editorial history.
-- PostgreSQL remains authoritative; all tenant-bearing links are composite and all
-- content revisions are immutable after insertion.
BEGIN;

CREATE TYPE "translation_editor_state" AS ENUM ('draft', 'in_review', 'approved');
CREATE TYPE "translation_generation_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- M6 dialogue anchors carry the committed M5 analysis id. This key lets the
-- database prove that an anchor and its immutable source segment share one run.
CREATE UNIQUE INDEX "dialogue_segments_id_analysis_key"
  ON "dialogue_segments" ("id", "speech_analysis_id");

CREATE TABLE "localization_workspaces" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "speech_analysis_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "localization_workspaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "localization_tracks" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "target_language_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "localization_tracks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "localization_scenes" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "localization_scenes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "localization_scenes_ordinal_check" CHECK ("ordinal" > 0)
);

CREATE TABLE "localization_scene_revisions" (
  "id" UUID NOT NULL,
  "scene_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "start_time_us" BIGINT NOT NULL,
  "end_time_us" BIGINT NOT NULL,
  "title" VARCHAR(200),
  "summary" VARCHAR(4000),
  "cultural_context" VARCHAR(8000),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "localization_scene_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "localization_scene_revisions_revision_check" CHECK ("revision_number" > 0),
  CONSTRAINT "localization_scene_revisions_time_range_check"
    CHECK ("start_time_us" >= 0 AND "end_time_us" > "start_time_us"),
  CONSTRAINT "localization_scene_revisions_title_check"
    CHECK ("title" IS NULL OR length(btrim("title")) > 0),
  CONSTRAINT "localization_scene_revisions_summary_check"
    CHECK ("summary" IS NULL OR length(btrim("summary")) > 0),
  CONSTRAINT "localization_scene_revisions_context_check"
    CHECK ("cultural_context" IS NULL OR length(btrim("cultural_context")) > 0)
);

CREATE TABLE "localization_scene_selections" (
  "scene_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "selected_revision_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" UUID NOT NULL,
  "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "localization_scene_selections_pkey"
    PRIMARY KEY ("scene_id", "organization_id", "project_id"),
  CONSTRAINT "localization_scene_selections_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "localized_dialogues" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "speech_analysis_id" UUID NOT NULL,
  "scene_id" UUID NOT NULL,
  "dialogue_segment_id" UUID NOT NULL,
  "sequence_number" INTEGER NOT NULL,
  "start_time_us" BIGINT NOT NULL,
  "end_time_us" BIGINT NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "localized_dialogues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "localized_dialogues_sequence_check" CHECK ("sequence_number" >= 0),
  CONSTRAINT "localized_dialogues_time_range_check"
    CHECK ("start_time_us" >= 0 AND "end_time_us" > "start_time_us")
);

CREATE TABLE "source_dialogue_revisions" (
  "id" UUID NOT NULL,
  "localized_dialogue_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "source_text" TEXT NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "source_dialogue_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_dialogue_revisions_revision_check" CHECK ("revision_number" > 0),
  CONSTRAINT "source_dialogue_revisions_text_check"
    CHECK (length(btrim("source_text")) > 0 AND octet_length("source_text") <= 65536)
);

CREATE TABLE "source_dialogue_selections" (
  "localized_dialogue_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "selected_revision_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" UUID NOT NULL,
  "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "source_dialogue_selections_pkey"
    PRIMARY KEY ("localized_dialogue_id", "organization_id", "project_id"),
  CONSTRAINT "source_dialogue_selections_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "dialogue_translations" (
  "id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "localized_dialogue_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dialogue_translations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "translation_generations" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "scene_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "status" "translation_generation_status" NOT NULL DEFAULT 'queued',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "lease_token" UUID,
  "leased_until" TIMESTAMPTZ(6),
  "heartbeat_at" TIMESTAMPTZ(6),
  "execution_id" UUID,
  "provider_name" VARCHAR(100) NOT NULL,
  "model_id" VARCHAR(160) NOT NULL,
  "model_revision" VARCHAR(160) NOT NULL,
  "runtime_version" VARCHAR(100) NOT NULL,
  "prompt_version" VARCHAR(100) NOT NULL,
  "configuration_snapshot" JSONB NOT NULL,
  "configuration_hash" CHAR(64) NOT NULL,
  "input_snapshot" JSONB NOT NULL,
  "input_revision_hash" CHAR(64) NOT NULL,
  "context_snapshot" JSONB NOT NULL,
  "context_snapshot_hash" CHAR(64) NOT NULL,
  "error_code" VARCHAR(100),
  "error_detail" TEXT,
  "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "translation_generations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "translation_generations_idempotency_key_check"
    CHECK (length(btrim("idempotency_key")) > 0),
  CONSTRAINT "translation_generations_attempts_check"
    CHECK ("max_attempts" BETWEEN 1 AND 10 AND "attempt_count" BETWEEN 0 AND "max_attempts"),
  CONSTRAINT "translation_generations_provider_check"
    CHECK (
      length(btrim("provider_name")) > 0
      AND length(btrim("model_id")) > 0
      AND length(btrim("model_revision")) > 0
      AND length(btrim("runtime_version")) > 0
      AND length(btrim("prompt_version")) > 0
    ),
  CONSTRAINT "translation_generations_hashes_check"
    CHECK (
      "configuration_hash" ~ '^[0-9a-f]{64}$'
      AND "input_revision_hash" ~ '^[0-9a-f]{64}$'
      AND "context_snapshot_hash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "translation_generations_snapshots_check"
    CHECK (
      jsonb_typeof("configuration_snapshot") = 'object'
      AND pg_column_size("configuration_snapshot") <= 65536
      AND jsonb_typeof("input_snapshot") = 'object'
      AND pg_column_size("input_snapshot") <= 1048576
      AND jsonb_typeof("context_snapshot") = 'object'
      AND pg_column_size("context_snapshot") <= 262144
    ),
  CONSTRAINT "translation_generations_error_check"
    CHECK (
      ("error_code" IS NULL OR length(btrim("error_code")) > 0)
      AND (
        "error_detail" IS NULL
        OR (length(btrim("error_detail")) > 0 AND octet_length("error_detail") <= 4000)
      )
    ),
  CONSTRAINT "translation_generations_state_check" CHECK (
    (
      "status" = 'queued'
      AND "lease_token" IS NULL
      AND "leased_until" IS NULL
      AND "heartbeat_at" IS NULL
      AND "execution_id" IS NULL
      AND "started_at" IS NULL
      AND "completed_at" IS NULL
      AND "error_code" IS NULL
      AND "error_detail" IS NULL
    )
    OR (
      "status" = 'running'
      AND "attempt_count" > 0
      AND "lease_token" IS NOT NULL
      AND "leased_until" IS NOT NULL
      AND "heartbeat_at" IS NOT NULL
      AND "execution_id" IS NOT NULL
      AND "started_at" IS NOT NULL
      AND "completed_at" IS NULL
      AND "error_code" IS NULL
      AND "error_detail" IS NULL
    )
    OR (
      "status" = 'succeeded'
      AND "attempt_count" > 0
      AND "lease_token" IS NULL
      AND "leased_until" IS NULL
      AND "heartbeat_at" IS NULL
      AND "execution_id" IS NOT NULL
      AND "started_at" IS NOT NULL
      AND "completed_at" IS NOT NULL
      AND "error_code" IS NULL
      AND "error_detail" IS NULL
    )
    OR (
      "status" = 'failed'
      AND "attempt_count" > 0
      AND "lease_token" IS NULL
      AND "leased_until" IS NULL
      AND "heartbeat_at" IS NULL
      AND "execution_id" IS NOT NULL
      AND "started_at" IS NOT NULL
      AND "completed_at" IS NOT NULL
      AND "error_code" IS NOT NULL
    )
  ),
  CONSTRAINT "translation_generations_lease_time_check"
    CHECK (
      "leased_until" IS NULL
      OR (
        "heartbeat_at" IS NOT NULL
        AND "started_at" IS NOT NULL
        AND "leased_until" > "heartbeat_at"
        AND "heartbeat_at" >= "started_at"
      )
    ),
  CONSTRAINT "translation_generations_chronology_check"
    CHECK (
      ("started_at" IS NULL OR "started_at" >= "queued_at")
      AND ("completed_at" IS NULL OR "completed_at" >= "started_at")
    )
);

CREATE TABLE "translation_revisions" (
  "id" UUID NOT NULL,
  "dialogue_translation_id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "localized_dialogue_id" UUID NOT NULL,
  "source_dialogue_revision_id" UUID NOT NULL,
  "generation_id" UUID,
  "revision_number" INTEGER NOT NULL,
  "translated_text" TEXT NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "translation_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "translation_revisions_revision_check" CHECK ("revision_number" > 0),
  CONSTRAINT "translation_revisions_text_check"
    CHECK (length(btrim("translated_text")) > 0 AND octet_length("translated_text") <= 65536)
);

CREATE TABLE "translation_selections" (
  "dialogue_translation_id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "selected_revision_id" UUID NOT NULL,
  "editor_state" "translation_editor_state" NOT NULL DEFAULT 'draft',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" UUID NOT NULL,
  "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "translation_selections_pkey"
    PRIMARY KEY ("dialogue_translation_id", "organization_id", "project_id"),
  CONSTRAINT "translation_selections_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "glossary_entries" (
  "id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "glossary_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "glossary_revisions" (
  "id" UUID NOT NULL,
  "glossary_entry_id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "source_term" VARCHAR(500) NOT NULL,
  "normalized_source_term" VARCHAR(500) NOT NULL,
  "target_term" VARCHAR(500),
  "notes" VARCHAR(2000),
  "case_sensitive" BOOLEAN NOT NULL DEFAULT false,
  "do_not_translate" BOOLEAN NOT NULL DEFAULT false,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "glossary_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "glossary_revisions_revision_check" CHECK ("revision_number" > 0),
  CONSTRAINT "glossary_revisions_source_term_check"
    CHECK (length(btrim("source_term")) > 0),
  -- Use the locale-neutral ICU root collation so Node/Python Unicode lowercase
  -- normalization and PostgreSQL enforce the same active-term identity.
  CONSTRAINT "glossary_revisions_normalized_term_check" CHECK (
    length("normalized_source_term") > 0
    AND "normalized_source_term" = CASE
      WHEN "case_sensitive" THEN btrim("source_term")
      ELSE lower(btrim("source_term") COLLATE "und-x-icu")
    END
  ),
  CONSTRAINT "glossary_revisions_target_policy_check" CHECK (
    ("do_not_translate" AND "target_term" IS NULL)
    OR (
      NOT "do_not_translate"
      AND "target_term" IS NOT NULL
      AND length(btrim("target_term")) > 0
    )
  ),
  CONSTRAINT "glossary_revisions_notes_check"
    CHECK ("notes" IS NULL OR length(btrim("notes")) > 0)
);

CREATE TABLE "glossary_selections" (
  "glossary_entry_id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "selected_revision_id" UUID NOT NULL,
  "selected_normalized_source_term" VARCHAR(500) NOT NULL,
  "selected_case_sensitive" BOOLEAN NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" UUID NOT NULL,
  "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "glossary_selections_pkey"
    PRIMARY KEY ("glossary_entry_id", "organization_id", "project_id"),
  CONSTRAINT "glossary_selections_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "glossary_selections_normalized_term_check"
    CHECK (length("selected_normalized_source_term") > 0)
);

-- Query-shaped and foreign-key indexes. Cursor APIs order on stable tie-breaker
-- UUIDs instead of using OFFSET for deep scene, revision, and generation pages.
CREATE INDEX "localization_workspaces_creator_idx"
  ON "localization_workspaces" ("organization_id", "created_by_user_id");
CREATE INDEX "localization_workspaces_project_tenant_idx"
  ON "localization_workspaces" ("project_id", "organization_id");
CREATE UNIQUE INDEX "localization_workspaces_org_project_key"
  ON "localization_workspaces" ("organization_id", "project_id");
CREATE UNIQUE INDEX "localization_workspaces_analysis_tenant_key"
  ON "localization_workspaces" ("speech_analysis_id", "organization_id", "project_id");
CREATE UNIQUE INDEX "localization_workspaces_id_tenant_key"
  ON "localization_workspaces" ("id", "organization_id", "project_id");
CREATE UNIQUE INDEX "localization_workspaces_id_analysis_tenant_key"
  ON "localization_workspaces" ("id", "speech_analysis_id", "organization_id", "project_id");

CREATE INDEX "localization_tracks_tenant_created_idx"
  ON "localization_tracks" ("organization_id", "project_id", "created_at", "id");
CREATE INDEX "localization_tracks_project_language_idx"
  ON "localization_tracks" ("project_id", "target_language_id");
CREATE INDEX "localization_tracks_creator_idx"
  ON "localization_tracks" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "localization_tracks_workspace_language_key"
  ON "localization_tracks" ("workspace_id", "target_language_id");
CREATE UNIQUE INDEX "localization_tracks_id_workspace_tenant_key"
  ON "localization_tracks" ("id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "localization_scenes_tenant_timeline_idx"
  ON "localization_scenes" ("organization_id", "project_id", "workspace_id", "ordinal", "id");
CREATE INDEX "localization_scenes_creator_idx"
  ON "localization_scenes" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "localization_scenes_workspace_ordinal_key"
  ON "localization_scenes" ("workspace_id", "ordinal");
CREATE UNIQUE INDEX "localization_scenes_id_workspace_tenant_key"
  ON "localization_scenes" ("id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "localization_scene_revisions_tenant_history_idx"
  ON "localization_scene_revisions"
  ("organization_id", "project_id", "scene_id", "revision_number" DESC, "id" DESC);
CREATE INDEX "localization_scene_revisions_creator_idx"
  ON "localization_scene_revisions" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "localization_scene_revisions_scene_revision_key"
  ON "localization_scene_revisions" ("scene_id", "revision_number");
CREATE UNIQUE INDEX "localization_scene_revisions_id_scene_tenant_key"
  ON "localization_scene_revisions"
  ("id", "scene_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "localization_scene_selections_updater_idx"
  ON "localization_scene_selections" ("organization_id", "updated_by_user_id");
CREATE UNIQUE INDEX "localization_scene_selections_scene_key"
  ON "localization_scene_selections"
  ("scene_id", "workspace_id", "organization_id", "project_id");
CREATE UNIQUE INDEX "localization_scene_selections_revision_key"
  ON "localization_scene_selections"
  ("selected_revision_id", "scene_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "localized_dialogues_tenant_scene_timeline_idx"
  ON "localized_dialogues"
  ("organization_id", "project_id", "scene_id", "start_time_us", "id");
CREATE INDEX "localized_dialogues_source_segment_idx"
  ON "localized_dialogues" ("dialogue_segment_id", "speech_analysis_id");
CREATE INDEX "localized_dialogues_creator_idx"
  ON "localized_dialogues" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "localized_dialogues_workspace_segment_key"
  ON "localized_dialogues" ("workspace_id", "dialogue_segment_id");
CREATE UNIQUE INDEX "localized_dialogues_workspace_sequence_key"
  ON "localized_dialogues" ("workspace_id", "sequence_number");
CREATE UNIQUE INDEX "localized_dialogues_id_workspace_tenant_key"
  ON "localized_dialogues" ("id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "source_dialogue_revisions_tenant_history_idx"
  ON "source_dialogue_revisions"
  ("organization_id", "project_id", "localized_dialogue_id", "revision_number" DESC, "id" DESC);
CREATE INDEX "source_dialogue_revisions_creator_idx"
  ON "source_dialogue_revisions" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "source_dialogue_revisions_dialogue_revision_key"
  ON "source_dialogue_revisions" ("localized_dialogue_id", "revision_number");
CREATE UNIQUE INDEX "source_dialogue_revisions_id_dialogue_tenant_key"
  ON "source_dialogue_revisions"
  ("id", "localized_dialogue_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "source_dialogue_selections_updater_idx"
  ON "source_dialogue_selections" ("organization_id", "updated_by_user_id");
CREATE UNIQUE INDEX "source_dialogue_selections_dialogue_key"
  ON "source_dialogue_selections"
  ("localized_dialogue_id", "workspace_id", "organization_id", "project_id");
CREATE UNIQUE INDEX "source_dialogue_selections_revision_key"
  ON "source_dialogue_selections"
  ("selected_revision_id", "localized_dialogue_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "dialogue_translations_tenant_track_created_idx"
  ON "dialogue_translations"
  ("organization_id", "project_id", "track_id", "created_at", "id");
CREATE INDEX "dialogue_translations_dialogue_idx"
  ON "dialogue_translations"
  ("localized_dialogue_id", "workspace_id", "organization_id", "project_id");
CREATE INDEX "dialogue_translations_creator_idx"
  ON "dialogue_translations" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "dialogue_translations_track_dialogue_key"
  ON "dialogue_translations" ("track_id", "localized_dialogue_id");
CREATE UNIQUE INDEX "dialogue_translations_id_track_tenant_key"
  ON "dialogue_translations"
  ("id", "track_id", "workspace_id", "organization_id", "project_id");

CREATE UNIQUE INDEX "translation_generations_execution_id_key"
  ON "translation_generations" ("execution_id");
CREATE INDEX "translation_generations_status_lease_idx"
  ON "translation_generations" ("status", "leased_until", "id");
CREATE INDEX "translation_generations_track_created_idx"
  ON "translation_generations" ("track_id", "created_at" DESC, "id" DESC);
CREATE INDEX "translation_generations_scene_created_idx"
  ON "translation_generations" ("scene_id", "created_at" DESC, "id" DESC);
CREATE INDEX "translation_generations_workspace_idx"
  ON "translation_generations" ("workspace_id", "organization_id", "project_id");
CREATE INDEX "translation_generations_tenant_queue_idx"
  ON "translation_generations"
  ("organization_id", "project_id", "status", "queued_at", "id");
CREATE INDEX "translation_generations_creator_idx"
  ON "translation_generations" ("organization_id", "created_by_user_id");
CREATE INDEX "translation_generations_claim_idx"
  ON "translation_generations" ("queued_at", "id")
  WHERE "status" = 'queued';
CREATE UNIQUE INDEX "translation_generations_track_idempotency_key"
  ON "translation_generations" ("track_id", "idempotency_key");
CREATE UNIQUE INDEX "translation_generations_id_track_tenant_key"
  ON "translation_generations"
  ("id", "track_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "translation_revisions_tenant_history_idx"
  ON "translation_revisions"
  ("organization_id", "project_id", "dialogue_translation_id", "revision_number" DESC, "id" DESC);
CREATE INDEX "translation_revisions_source_revision_idx"
  ON "translation_revisions"
  ("source_dialogue_revision_id", "localized_dialogue_id", "workspace_id", "organization_id", "project_id");
CREATE INDEX "translation_revisions_generation_idx"
  ON "translation_revisions"
  ("generation_id", "track_id", "workspace_id", "organization_id", "project_id");
CREATE INDEX "translation_revisions_creator_idx"
  ON "translation_revisions" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "translation_revisions_translation_revision_key"
  ON "translation_revisions" ("dialogue_translation_id", "revision_number");
CREATE UNIQUE INDEX "translation_revisions_id_translation_tenant_key"
  ON "translation_revisions"
  ("id", "dialogue_translation_id", "track_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "translation_selections_editor_queue_idx"
  ON "translation_selections"
  ("organization_id", "project_id", "track_id", "editor_state", "updated_at", "dialogue_translation_id");
CREATE INDEX "translation_selections_updater_idx"
  ON "translation_selections" ("organization_id", "updated_by_user_id");
CREATE UNIQUE INDEX "translation_selections_translation_key"
  ON "translation_selections"
  ("dialogue_translation_id", "track_id", "workspace_id", "organization_id", "project_id");
CREATE UNIQUE INDEX "translation_selections_revision_key"
  ON "translation_selections"
  ("selected_revision_id", "dialogue_translation_id", "track_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "glossary_entries_tenant_track_created_idx"
  ON "glossary_entries" ("organization_id", "project_id", "track_id", "created_at", "id");
CREATE INDEX "glossary_entries_creator_idx"
  ON "glossary_entries" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "glossary_entries_id_track_tenant_key"
  ON "glossary_entries" ("id", "track_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "glossary_revisions_tenant_source_term_idx"
  ON "glossary_revisions"
  ("organization_id", "project_id", "track_id", "normalized_source_term", "id");
CREATE INDEX "glossary_revisions_tenant_history_idx"
  ON "glossary_revisions"
  ("organization_id", "project_id", "glossary_entry_id", "revision_number" DESC, "id" DESC);
CREATE INDEX "glossary_revisions_creator_idx"
  ON "glossary_revisions" ("organization_id", "created_by_user_id");
CREATE UNIQUE INDEX "glossary_revisions_entry_revision_key"
  ON "glossary_revisions" ("glossary_entry_id", "revision_number");
CREATE UNIQUE INDEX "glossary_revisions_id_entry_tenant_key"
  ON "glossary_revisions"
  ("id", "glossary_entry_id", "track_id", "workspace_id", "organization_id", "project_id");

CREATE INDEX "glossary_selections_updater_idx"
  ON "glossary_selections" ("organization_id", "updated_by_user_id");
CREATE UNIQUE INDEX "glossary_selections_entry_key"
  ON "glossary_selections"
  ("glossary_entry_id", "track_id", "workspace_id", "organization_id", "project_id");
CREATE UNIQUE INDEX "glossary_selections_revision_key"
  ON "glossary_selections"
  ("selected_revision_id", "glossary_entry_id", "track_id", "workspace_id", "organization_id", "project_id");
CREATE UNIQUE INDEX "glossary_selections_active_source_key"
  ON "glossary_selections"
  ("track_id", "selected_case_sensitive", "selected_normalized_source_term");

-- Composite foreign keys make every tenant/project edge provable in PostgreSQL.
ALTER TABLE "localization_workspaces"
  ADD CONSTRAINT "localization_workspaces_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_workspaces_project_id_organization_id_fkey"
    FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects" ("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_workspaces_speech_analysis_fkey"
    FOREIGN KEY ("speech_analysis_id", "organization_id", "project_id")
    REFERENCES "speech_analyses" ("id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "localization_workspaces_committed_selection_fkey"
    FOREIGN KEY ("speech_analysis_id", "organization_id", "project_id")
    REFERENCES "project_speech_analysis_selections" ("speech_analysis_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "localization_workspaces_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "localization_tracks"
  ADD CONSTRAINT "localization_tracks_workspace_id_organization_id_project_i_fkey"
    FOREIGN KEY ("workspace_id", "organization_id", "project_id")
    REFERENCES "localization_workspaces" ("id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_tracks_project_id_target_language_id_fkey"
    FOREIGN KEY ("project_id", "target_language_id")
    REFERENCES "project_target_languages" ("project_id", "language_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_tracks_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "localization_scenes"
  ADD CONSTRAINT "localization_scenes_workspace_id_organization_id_project_i_fkey"
    FOREIGN KEY ("workspace_id", "organization_id", "project_id")
    REFERENCES "localization_workspaces" ("id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_scenes_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "localization_scene_revisions"
  ADD CONSTRAINT "localization_scene_revisions_scene_id_workspace_id_organiz_fkey"
    FOREIGN KEY ("scene_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_scenes" ("id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_scene_revisions_organization_id_created_by_us_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "localization_scene_selections"
  ADD CONSTRAINT "localization_scene_selections_scene_id_workspace_id_organi_fkey"
    FOREIGN KEY ("scene_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_scenes" ("id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_scene_selections_selected_revision_id_scene_i_fkey"
    FOREIGN KEY ("selected_revision_id", "scene_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_scene_revisions" ("id", "scene_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "localization_scene_selections_organization_id_updated_by_u_fkey"
    FOREIGN KEY ("organization_id", "updated_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "localized_dialogues"
  ADD CONSTRAINT "localized_dialogues_workspace_id_speech_analysis_id_organi_fkey"
    FOREIGN KEY ("workspace_id", "speech_analysis_id", "organization_id", "project_id")
    REFERENCES "localization_workspaces" ("id", "speech_analysis_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "localized_dialogues_scene_id_workspace_id_organization_id__fkey"
    FOREIGN KEY ("scene_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_scenes" ("id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "localized_dialogues_dialogue_segment_id_speech_analysis_id_fkey"
    FOREIGN KEY ("dialogue_segment_id", "speech_analysis_id")
    REFERENCES "dialogue_segments" ("id", "speech_analysis_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "localized_dialogues_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_dialogue_revisions"
  ADD CONSTRAINT "source_dialogue_revisions_localized_dialogue_id_workspace__fkey"
    FOREIGN KEY ("localized_dialogue_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localized_dialogues" ("id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "source_dialogue_revisions_organization_id_created_by_user__fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_dialogue_selections"
  ADD CONSTRAINT "source_dialogue_selections_localized_dialogue_id_workspace_fkey"
    FOREIGN KEY ("localized_dialogue_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localized_dialogues" ("id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "source_dialogue_selections_selected_revision_id_localized__fkey"
    FOREIGN KEY ("selected_revision_id", "localized_dialogue_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "source_dialogue_revisions" ("id", "localized_dialogue_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "source_dialogue_selections_organization_id_updated_by_user_fkey"
    FOREIGN KEY ("organization_id", "updated_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dialogue_translations"
  ADD CONSTRAINT "dialogue_translations_track_id_workspace_id_organization_i_fkey"
    FOREIGN KEY ("track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_tracks" ("id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "dialogue_translations_localized_dialogue_id_workspace_id_o_fkey"
    FOREIGN KEY ("localized_dialogue_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localized_dialogues" ("id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "dialogue_translations_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "translation_generations"
  ADD CONSTRAINT "translation_generations_workspace_id_organization_id_proje_fkey"
    FOREIGN KEY ("workspace_id", "organization_id", "project_id")
    REFERENCES "localization_workspaces" ("id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_generations_track_id_workspace_id_organization_fkey"
    FOREIGN KEY ("track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_tracks" ("id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_generations_scene_id_workspace_id_organization_fkey"
    FOREIGN KEY ("scene_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_scenes" ("id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_generations_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "translation_revisions"
  ADD CONSTRAINT "translation_revisions_dialogue_translation_id_track_id_wor_fkey"
    FOREIGN KEY ("dialogue_translation_id", "track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "dialogue_translations" ("id", "track_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_revisions_source_dialogue_revision_id_localize_fkey"
    FOREIGN KEY ("source_dialogue_revision_id", "localized_dialogue_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "source_dialogue_revisions" ("id", "localized_dialogue_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_revisions_generation_id_track_id_workspace_id__fkey"
    FOREIGN KEY ("generation_id", "track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "translation_generations" ("id", "track_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_revisions_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "translation_selections"
  ADD CONSTRAINT "translation_selections_dialogue_translation_id_track_id_wo_fkey"
    FOREIGN KEY ("dialogue_translation_id", "track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "dialogue_translations" ("id", "track_id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_selections_selected_revision_id_dialogue_trans_fkey"
    FOREIGN KEY ("selected_revision_id", "dialogue_translation_id", "track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "translation_revisions" ("id", "dialogue_translation_id", "track_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "translation_selections_organization_id_updated_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "updated_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "glossary_entries"
  ADD CONSTRAINT "glossary_entries_track_id_workspace_id_organization_id_pro_fkey"
    FOREIGN KEY ("track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "localization_tracks" ("id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "glossary_entries_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "glossary_revisions"
  ADD CONSTRAINT "glossary_revisions_glossary_entry_id_track_id_workspace_id_fkey"
    FOREIGN KEY ("glossary_entry_id", "track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "glossary_entries" ("id", "track_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "glossary_revisions_organization_id_created_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "created_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "glossary_selections"
  ADD CONSTRAINT "glossary_selections_glossary_entry_id_track_id_workspace_i_fkey"
    FOREIGN KEY ("glossary_entry_id", "track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "glossary_entries" ("id", "track_id", "workspace_id", "organization_id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "glossary_selections_selected_revision_id_glossary_entry_id_fkey"
    FOREIGN KEY ("selected_revision_id", "glossary_entry_id", "track_id", "workspace_id", "organization_id", "project_id")
    REFERENCES "glossary_revisions" ("id", "glossary_entry_id", "track_id", "workspace_id", "organization_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "glossary_selections_organization_id_updated_by_user_id_fkey"
    FOREIGN KEY ("organization_id", "updated_by_user_id")
    REFERENCES "organization_memberships" ("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Revision rows are true append-only history. Selection rows are the only mutable
-- pointers and carry their own optimistic revision counters.
CREATE FUNCTION "prevent_localization_revision_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%s rows are append-only', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER "localization_scene_revisions_append_only"
  BEFORE UPDATE OR DELETE ON "localization_scene_revisions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_localization_revision_mutation"();
CREATE TRIGGER "source_dialogue_revisions_append_only"
  BEFORE UPDATE OR DELETE ON "source_dialogue_revisions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_localization_revision_mutation"();
CREATE TRIGGER "translation_revisions_append_only"
  BEFORE UPDATE OR DELETE ON "translation_revisions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_localization_revision_mutation"();
CREATE TRIGGER "glossary_revisions_append_only"
  BEFORE UPDATE OR DELETE ON "glossary_revisions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_localization_revision_mutation"();

-- The selected normalized glossary key is a small mutable projection used only
-- to enforce uniqueness across current selections. The trigger proves it is an
-- exact projection of the immutable selected revision before the unique index is
-- evaluated.
CREATE FUNCTION "validate_glossary_selection_projection"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  expected_normalized_term VARCHAR(500);
  expected_case_sensitive BOOLEAN;
BEGIN
  SELECT revision."normalized_source_term", revision."case_sensitive"
  INTO expected_normalized_term, expected_case_sensitive
  FROM "glossary_revisions" AS revision
  WHERE revision."id" = NEW."selected_revision_id"
    AND revision."glossary_entry_id" = NEW."glossary_entry_id"
    AND revision."track_id" = NEW."track_id"
    AND revision."workspace_id" = NEW."workspace_id"
    AND revision."organization_id" = NEW."organization_id"
    AND revision."project_id" = NEW."project_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'selected glossary revision does not belong to the glossary entry';
  END IF;

  IF NEW."selected_normalized_source_term" IS DISTINCT FROM expected_normalized_term
     OR NEW."selected_case_sensitive" IS DISTINCT FROM expected_case_sensitive THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'selected glossary projection does not match the selected revision';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "glossary_selections_validate_projection"
  BEFORE INSERT OR UPDATE OF
    "selected_revision_id", "glossary_entry_id", "track_id", "workspace_id",
    "organization_id", "project_id", "selected_normalized_source_term",
    "selected_case_sensitive"
  ON "glossary_selections"
  FOR EACH ROW EXECUTE FUNCTION "validate_glossary_selection_projection"();

-- Status/lease metadata is mutable, but the provider, model, prompt, hashes, and
-- bounded input/context snapshots are the permanent provenance of one request.
CREATE FUNCTION "prevent_translation_generation_provenance_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."id",
    NEW."organization_id",
    NEW."project_id",
    NEW."workspace_id",
    NEW."track_id",
    NEW."scene_id",
    NEW."created_by_user_id",
    NEW."idempotency_key",
    NEW."max_attempts",
    NEW."provider_name",
    NEW."model_id",
    NEW."model_revision",
    NEW."runtime_version",
    NEW."prompt_version",
    NEW."configuration_snapshot",
    NEW."configuration_hash",
    NEW."input_snapshot",
    NEW."input_revision_hash",
    NEW."context_snapshot",
    NEW."context_snapshot_hash",
    NEW."queued_at",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id",
    OLD."organization_id",
    OLD."project_id",
    OLD."workspace_id",
    OLD."track_id",
    OLD."scene_id",
    OLD."created_by_user_id",
    OLD."idempotency_key",
    OLD."max_attempts",
    OLD."provider_name",
    OLD."model_id",
    OLD."model_revision",
    OLD."runtime_version",
    OLD."prompt_version",
    OLD."configuration_snapshot",
    OLD."configuration_hash",
    OLD."input_snapshot",
    OLD."input_revision_hash",
    OLD."context_snapshot",
    OLD."context_snapshot_hash",
    OLD."queued_at",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'translation generation provenance is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "translation_generations_immutable_provenance"
  BEFORE UPDATE ON "translation_generations"
  FOR EACH ROW EXECUTE FUNCTION "prevent_translation_generation_provenance_mutation"();

-- Supabase supplies private PostgreSQL; confidential localization content and
-- generation snapshots are never browser Data API surfaces. Keep this explicit
-- even though the platform migration also hardens default privileges.
DO $voiceverse$
DECLARE
  api_role name;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE localization_workspaces, localization_tracks, localization_scenes, localization_scene_revisions, localization_scene_selections, localized_dialogues, source_dialogue_revisions, source_dialogue_selections, dialogue_translations, translation_revisions, translation_selections, glossary_entries, glossary_revisions, glossary_selections, translation_generations FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$voiceverse$;

COMMIT;
