-- CreateEnum
CREATE TYPE "project_status" AS ENUM ('draft', 'ingesting', 'processing', 'ready', 'failed', 'archived');

-- CreateEnum
CREATE TYPE "identity_provider" AS ENUM ('google');

-- CreateEnum
CREATE TYPE "video_ingest_status" AS ENUM ('awaiting_upload', 'uploading', 'uploaded', 'aborted', 'failed');

-- CreateEnum
CREATE TYPE "media_security_status" AS ENUM ('pending', 'scanning', 'clean', 'infected', 'error');

-- CreateEnum
CREATE TYPE "multipart_upload_status" AS ENUM ('initiated', 'completing', 'completed', 'aborted', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "malware_scan_status" AS ENUM ('queued', 'running', 'clean', 'infected', 'error');

-- DropIndex
DROP INDEX "outbox_events_dispatch_idx";

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "lease_id" UUID,
ADD COLUMN     "leased_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "languages" (
    "id" UUID NOT NULL,
    "bcp47_tag" VARCHAR(35) NOT NULL,
    "english_name" VARCHAR(100) NOT NULL,
    "native_name" VARCHAR(100) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "source_language_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "project_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_target_languages" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_target_languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "identity_provider" NOT NULL,
    "provider_subject" VARCHAR(191) NOT NULL,
    "email_at_link" VARCHAR(320) NOT NULL,
    "last_login_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorizations" (
    "id" UUID NOT NULL,
    "provider" "identity_provider" NOT NULL,
    "state_hash" CHAR(64) NOT NULL,
    "nonce_hash" CHAR(64) NOT NULL,
    "code_verifier_ciphertext" TEXT NOT NULL,
    "redirect_path" VARCHAR(512) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "user_agent_hash" CHAR(64),
    "ip_address_hash" CHAR(64),
    "replaced_by_session_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "media_type" VARCHAR(127) NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "sha256" CHAR(64),
    "storage_bucket" VARCHAR(255) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "storage_etag" VARCHAR(512),
    "ingest_status" "video_ingest_status" NOT NULL DEFAULT 'awaiting_upload',
    "security_status" "media_security_status" NOT NULL DEFAULT 'pending',
    "uploaded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multipart_uploads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "provider_upload_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "part_size" INTEGER NOT NULL,
    "total_parts" INTEGER NOT NULL,
    "status" "multipart_upload_status" NOT NULL DEFAULT 'initiated',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "aborted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "multipart_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multipart_upload_parts" (
    "id" UUID NOT NULL,
    "multipart_upload_id" UUID NOT NULL,
    "part_number" INTEGER NOT NULL,
    "etag" VARCHAR(512) NOT NULL,
    "byte_size" BIGINT,
    "checksum_sha256" CHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "multipart_upload_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "malware_scan_attempts" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "malware_scan_status" NOT NULL DEFAULT 'queued',
    "engine" VARCHAR(100) NOT NULL,
    "engine_version" VARCHAR(100),
    "signature_version" VARCHAR(100),
    "finding_name" VARCHAR(255),
    "error_code" VARCHAR(100),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "malware_scan_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "languages_bcp47_tag_key" ON "languages"("bcp47_tag");

-- CreateIndex
CREATE INDEX "languages_enabled_name_idx" ON "languages"("enabled", "english_name");

-- CreateIndex
CREATE INDEX "projects_org_updated_idx" ON "projects"("organization_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "projects_org_status_updated_idx" ON "projects"("organization_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "projects_created_by_user_id_idx" ON "projects"("created_by_user_id");

-- CreateIndex
CREATE INDEX "projects_source_language_id_idx" ON "projects"("source_language_id");

-- CreateIndex
CREATE INDEX "project_target_languages_language_id_idx" ON "project_target_languages"("language_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_target_languages_project_language_key" ON "project_target_languages"("project_id", "language_id");

-- CreateIndex
CREATE INDEX "external_identities_user_id_idx" ON "external_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_provider_subject_key" ON "external_identities"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorizations_state_hash_key" ON "oauth_authorizations"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_authorizations_expires_at_idx" ON "oauth_authorizations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key" ON "auth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_replaced_by_session_id_key" ON "auth_sessions"("replaced_by_session_id");

-- CreateIndex
CREATE INDEX "auth_sessions_user_expires_idx" ON "auth_sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_family_id_idx" ON "auth_sessions"("family_id");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "videos_org_created_idx" ON "videos"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "videos_project_created_idx" ON "videos"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "videos_created_by_user_id_idx" ON "videos"("created_by_user_id");

-- CreateIndex
CREATE INDEX "videos_org_security_created_idx" ON "videos"("organization_id", "security_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "videos_storage_location_key" ON "videos"("storage_bucket", "storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "multipart_uploads_provider_upload_id_key" ON "multipart_uploads"("provider_upload_id");

-- CreateIndex
CREATE INDEX "multipart_uploads_video_status_idx" ON "multipart_uploads"("video_id", "status");

-- CreateIndex
CREATE INDEX "multipart_uploads_org_status_expires_idx" ON "multipart_uploads"("organization_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "multipart_uploads_org_idempotency_key" ON "multipart_uploads"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "multipart_upload_parts_upload_part_key" ON "multipart_upload_parts"("multipart_upload_id", "part_number");

-- CreateIndex
CREATE INDEX "malware_scan_attempts_status_created_idx" ON "malware_scan_attempts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "malware_scan_attempts_video_attempt_key" ON "malware_scan_attempts"("video_id", "attempt_number");

-- CreateIndex
CREATE INDEX "outbox_events_dispatch_idx" ON "outbox_events"("status", "available_at", "leased_until");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_language_id_fkey" FOREIGN KEY ("source_language_id") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_target_languages" ADD CONSTRAINT "project_target_languages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_target_languages" ADD CONSTRAINT "project_target_languages_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_replaced_by_session_id_fkey" FOREIGN KEY ("replaced_by_session_id") REFERENCES "auth_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multipart_uploads" ADD CONSTRAINT "multipart_uploads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multipart_uploads" ADD CONSTRAINT "multipart_uploads_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multipart_upload_parts" ADD CONSTRAINT "multipart_upload_parts_multipart_upload_id_fkey" FOREIGN KEY ("multipart_upload_id") REFERENCES "multipart_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "malware_scan_attempts" ADD CONSTRAINT "malware_scan_attempts_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
