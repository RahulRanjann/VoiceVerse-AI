ALTER TABLE "auth_sessions"
  ADD COLUMN "organization_id" UUID;

-- No production session exists before this milestone. The guarded backfill keeps the
-- migration valid for developer databases that exercised an earlier schema draft.
UPDATE "auth_sessions" AS session
SET "organization_id" = (
  SELECT membership."organization_id"
  FROM "organization_memberships" AS membership
  WHERE membership."user_id" = session."user_id"
  ORDER BY membership."created_at" ASC
  LIMIT 1
)
WHERE session."organization_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "auth_sessions" WHERE "organization_id" IS NULL) THEN
    RAISE EXCEPTION 'Cannot assign tenant context to every existing auth session';
  END IF;
END
$$;

ALTER TABLE "auth_sessions"
  ALTER COLUMN "organization_id" SET NOT NULL,
  ADD CONSTRAINT "auth_sessions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "auth_sessions_org_user_expires_idx"
  ON "auth_sessions" ("organization_id", "user_id", "expires_at");
