#!/usr/bin/env bash

set -euo pipefail

: "${DIRECT_URL:?DIRECT_URL must point to an empty PostgreSQL rehearsal database}"

repository_root="$(git rev-parse --show-toplevel)"
migrations_root="${repository_root}/packages/database/prisma/migrations"

pre_m5_migrations=(
  20260716070000_platform_foundation
  20260716092148_init
  20260716094000_secure_ingest_hardening
  20260716095000_auth_session_tenant_context
  20260716100000_outbox_deduplication
  20260716163000_supabase_data_api_hardening
  20260716190000_supabase_auth_identity
  20260717103000_durable_workflow_media_preparation
)

for migration in "${pre_m5_migrations[@]}"; do
  psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
    --file "${migrations_root}/${migration}/migration.sql"
done

psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
  --file "${repository_root}/packages/database/scripts/sql/m5-upgrade-fixture.sql"
psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
  --file "${migrations_root}/20260717150000_m5_speech_analysis_enum_extensions/migration.sql"
psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
  --file "${migrations_root}/20260717151000_m5_speech_analysis_foundation/migration.sql"
psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
  --file "${repository_root}/packages/database/scripts/sql/verify-m5-upgrade.sql"

psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
  --file "${migrations_root}/20260717190000_scene_aware_contextual_translation/migration.sql"

# Re-prove that the additive M6 migration did not damage representative M5 state,
# then verify M6-specific privacy and invariant scaffolding.
psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
  --file "${repository_root}/packages/database/scripts/sql/verify-m5-upgrade.sql"
psql "${DIRECT_URL}" --set ON_ERROR_STOP=1 \
  --file "${repository_root}/packages/database/scripts/sql/verify-m6-upgrade.sql"

pnpm --dir "${repository_root}" --filter @voiceverse/database exec prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma \
  --exit-code
