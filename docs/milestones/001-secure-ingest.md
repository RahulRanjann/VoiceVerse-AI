# Milestone 1: Tenant identity and secure media ingest

Status: **Implementation complete — July 16, 2026**

The automated acceptance suite and live browser/API/PostgreSQL/Redis flow pass. A full
all-container smoke run remains an environment-validation item because the local Docker
Desktop data disk became read-only; no destructive Docker reset was performed.

## 1. Goal

Deliver the first production vertical slice: a studio operator signs in, receives an
organization-scoped session, creates a project, uploads an MP4 resumably and directly to
S3, and sees the file remain quarantined until malware scanning completes.

Acceptance criteria:

- Google OIDC uses authorization code, PKCE, nonce, and one-time state.
- Access JWTs are short-lived; refresh sessions rotate and detect reuse.
- Every project/media query is constrained by authenticated organization context.
- Multipart create, part signing, completion, status, and abort are idempotent.
- Uploaded media cannot enter processing before an explicit clean scan result.
- Database, queue, storage, scanner, and UI behavior have unit/integration contracts.

## 2. Folder structure

```text
apps/api/src/modules/identity       authentication and authorization
apps/api/src/modules/projects       project catalog and language reference
apps/api/src/modules/media-ingest   multipart upload application services
apps/api/src/modules/workers        outbox relay, scan queue, and malware worker
apps/api/src/worker.ts              independently scalable worker entry point
apps/web/src/app/login              sign-in surface
apps/web/src/features/studio        authenticated product shell
apps/web/src/features/uploads       resumable browser upload client
apps/web/e2e                        deterministic browser acceptance tests
packages/database/prisma/models     normalized domain schemas
infrastructure/clamav               local scanner configuration
infrastructure/minio                direct-upload CORS policy
```

## 3. Database changes

Add external identities, OAuth transactions, rotating auth sessions, languages,
projects, project target languages, videos, multipart uploads and parts, and malware
scan attempts. Tenant-owned tables retain an organization foreign key for explicit
boundary checks. Foreign keys and list/status access paths are indexed. Outbox events
include deduplication, lease, retry, and publication state. PostgreSQL connections are
forced to UTC so driver-adapter timestamp semantics remain stable across host time zones.

## 4. APIs

- `GET /v1/auth/google/start`
- `GET /v1/auth/google/callback`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`
- `GET /v1/languages`
- `GET|POST /v1/projects`
- `POST /v1/projects/:projectId/videos/multipart-uploads`
- `POST /v1/multipart-uploads/:uploadId/parts/sign`
- `POST /v1/multipart-uploads/:uploadId/complete`
- `GET|DELETE /v1/multipart-uploads/:uploadId`

## 5. Frontend pages

- Google sign-in page
- Responsive studio dashboard
- Recent-project state and empty/loading/error states
- Project creation plus resumable upload dialog

## 6. Backend implementation

NestJS owns identity, tenant policy, project/media state, signed URL issuance, audit
events, and the transactional outbox. External identity, object storage, and malware
scanning are ports with infrastructure adapters. Multipart completion records the client
manifest before provider finalization and reconciles ambiguous provider responses with
object metadata. The outbox relay and scanner run from a separately scalable worker
entry point.

## 7. AI service

No model is loaded. The AI execution plane remains downstream of the clean-media gate.
Its readiness contract is unchanged.

## 8. Tests

Unit tests cover configuration, token rotation/reuse, tenant authorization, upload
validation, multipart manifests, scanner protocol parsing, retries, and idempotency.
HTTP integration tests cover dependency-aware health contracts. Fresh-database migration
deployment validates PostgreSQL constraints and reference data. Frontend unit tests cover
API handling, checkpoint durability, concurrent multipart transfer, resume, completion,
failure, and cancellation. Playwright tests cover anonymous sign-in routing, the
responsive dashboard, keyboard search, upload entry, and mobile navigation. A live
browser pass also exercises rotating-cookie authentication against the real API and
database.

## 9. Docker updates

Add the official ClamAV daemon, persistent signatures, a worker runtime, private service
networking, scanner health checks, MinIO CORS, read-only application filesystems, and
separate API/worker health checks. Keep scanner and database ports off public interfaces.
The official scanner image is amd64-only, so Apple Silicon development uses emulation.

## 10. Deployment

Deploy API and worker separately from the same immutable image. Give the API only
multipart-control permissions and the worker read/quarantine permissions. Configure
Kubernetes readiness around database, Redis, S3, and scanner dependencies. Autoscale
workers from queue latency; do not autoscale scanner memory blindly.

## 11. Risks

- Google credentials are external configuration, so local verification uses provider
  contract fakes rather than a real consent screen.
- ClamAV throughput and maximum stream size can be limiting for feature-length masters.
- Browser multipart uploads need explicit retry/backoff and abandoned-upload cleanup.
- Cookie behavior differs across custom domains; production uses same-site web/API hosts.

## 12. Improvements

- Organization switching, invitations, passkeys, and enterprise SSO.
- Managed malware scanning and content-disarm policy where required.
- Checksums per part/object, lifecycle expiration, and multi-region transfer acceleration.
- Durable dubbing job/stage/attempt state machine in Milestone 3, after the cloud
  foundation prerequisite.
