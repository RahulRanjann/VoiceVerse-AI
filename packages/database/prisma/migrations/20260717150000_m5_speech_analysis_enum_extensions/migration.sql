-- PostgreSQL enum additions must commit before a later transaction can safely use
-- the new values in rows, defaults, checks, or partial-index predicates. Keep this
-- migration deliberately outside an explicit transaction; the next migration owns
-- all structural changes atomically.

ALTER TYPE "workflow_job_kind" ADD VALUE IF NOT EXISTS 'speech_analysis';

ALTER TYPE "workflow_stage_kind" ADD VALUE IF NOT EXISTS 'vocal_separation';
ALTER TYPE "workflow_stage_kind" ADD VALUE IF NOT EXISTS 'speech_recognition';
ALTER TYPE "workflow_stage_kind" ADD VALUE IF NOT EXISTS 'speaker_diarization';
ALTER TYPE "workflow_stage_kind" ADD VALUE IF NOT EXISTS 'character_identification';

ALTER TYPE "workflow_stage_status" ADD VALUE IF NOT EXISTS 'blocked' BEFORE 'queued';

ALTER TYPE "media_artifact_kind" ADD VALUE IF NOT EXISTS 'vocal_separation_manifest';
ALTER TYPE "media_artifact_kind" ADD VALUE IF NOT EXISTS 'vocal_stem_audio';
ALTER TYPE "media_artifact_kind" ADD VALUE IF NOT EXISTS 'accompaniment_stem_audio';
ALTER TYPE "media_artifact_kind" ADD VALUE IF NOT EXISTS 'speech_analysis_audio';
ALTER TYPE "media_artifact_kind" ADD VALUE IF NOT EXISTS 'transcription_manifest';
ALTER TYPE "media_artifact_kind" ADD VALUE IF NOT EXISTS 'diarization_manifest';
ALTER TYPE "media_artifact_kind" ADD VALUE IF NOT EXISTS 'character_identification_manifest';
