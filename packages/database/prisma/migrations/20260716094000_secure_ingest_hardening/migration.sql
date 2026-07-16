-- Data integrity that Prisma cannot express in the schema.
ALTER TABLE "external_identities"
  ADD CONSTRAINT "external_identities_email_normalized_check"
  CHECK ("email_at_link" = lower("email_at_link"));

ALTER TABLE "oauth_authorizations"
  ADD CONSTRAINT "oauth_authorizations_expiry_check"
  CHECK ("expires_at" > "created_at");

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_expiry_check"
  CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "auth_sessions_rotation_time_check"
  CHECK ("rotated_at" IS NULL OR "rotated_at" >= "created_at"),
  ADD CONSTRAINT "auth_sessions_revocation_time_check"
  CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at");

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_name_not_blank_check"
  CHECK (length(btrim("name")) > 0);

ALTER TABLE "videos"
  ADD CONSTRAINT "videos_byte_size_check"
  CHECK ("byte_size" > 0),
  ADD CONSTRAINT "videos_sha256_format_check"
  CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "videos_upload_state_check"
  CHECK (
    ("ingest_status" = 'uploaded' AND "uploaded_at" IS NOT NULL)
    OR "ingest_status" <> 'uploaded'
  );

ALTER TABLE "multipart_uploads"
  ADD CONSTRAINT "multipart_uploads_part_size_check"
  CHECK ("part_size" >= 5242880),
  ADD CONSTRAINT "multipart_uploads_total_parts_check"
  CHECK ("total_parts" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "multipart_uploads_expiry_check"
  CHECK ("expires_at" > "created_at");

ALTER TABLE "multipart_upload_parts"
  ADD CONSTRAINT "multipart_upload_parts_number_check"
  CHECK ("part_number" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "multipart_upload_parts_byte_size_check"
  CHECK ("byte_size" IS NULL OR "byte_size" > 0),
  ADD CONSTRAINT "multipart_upload_parts_checksum_format_check"
  CHECK ("checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "malware_scan_attempts"
  ADD CONSTRAINT "malware_scan_attempts_attempt_number_check"
  CHECK ("attempt_number" > 0),
  ADD CONSTRAINT "malware_scan_attempts_completion_check"
  CHECK ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at");

-- Partial indexes keep hot operational paths small as historical rows accumulate.
CREATE INDEX "auth_sessions_active_user_idx"
  ON "auth_sessions" ("user_id", "expires_at")
  WHERE "revoked_at" IS NULL;

CREATE INDEX "outbox_events_pending_available_idx"
  ON "outbox_events" ("available_at")
  WHERE "status" IN ('pending', 'failed');

CREATE INDEX "multipart_uploads_active_expiry_idx"
  ON "multipart_uploads" ("expires_at")
  WHERE "status" IN ('initiated', 'completing');

CREATE INDEX "videos_pipeline_eligible_idx"
  ON "videos" ("organization_id", "created_at")
  WHERE "ingest_status" = 'uploaded' AND "security_status" = 'clean';

-- Stable reference rows used by API validation and the first upload experience.
INSERT INTO "languages" ("id", "bcp47_tag", "english_name", "native_name")
VALUES
  ('019b52ac-4000-7000-8000-000000000001', 'en', 'English', 'English'),
  ('019b52ac-4000-7000-8000-000000000002', 'hi', 'Hindi', 'हिन्दी'),
  ('019b52ac-4000-7000-8000-000000000003', 'ta', 'Tamil', 'தமிழ்'),
  ('019b52ac-4000-7000-8000-000000000004', 'es', 'Spanish', 'Español')
ON CONFLICT ("bcp47_tag") DO UPDATE
SET "english_name" = EXCLUDED."english_name",
    "native_name" = EXCLUDED."native_name",
    "enabled" = true;
