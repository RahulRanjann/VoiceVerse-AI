# Milestone 0: Platform foundation

Status: **Complete — July 16, 2026**

The final verification passed formatting, linting, strict type checks, 16 unit/HTTP
contract tests, enforced coverage thresholds, production builds, Prisma migration
deployment, Compose validation, three container-image builds, and live health checks
for the web, control plane, AI service, PostgreSQL, Redis, and MinIO.

## 1. Goal

Create a reproducible, observable, security-conscious repository in which the web, control-plane API, AI service, PostgreSQL, Redis, and S3-compatible local storage can boot and expose health contracts. No dubbing behavior is included.

Acceptance criteria:

- A new engineer can bootstrap from documented commands.
- All runtimes are version-pinned and dependency-locked.
- API and AI services fail fast on invalid production configuration.
- Liveness does not depend on external services; readiness does.
- Structured logs and metrics are available without leaking media or credentials.
- Formatting, linting, type checks, unit tests, and builds pass in CI.

## 2. Folder structure

```text
apps/web                 Next.js application shell
apps/api                 NestJS modular control plane
packages/database        Prisma schema and client factory
services/ai              FastAPI execution-plane shell
infrastructure/docker    Local PostgreSQL, Redis, and object storage
infrastructure/observability  OpenTelemetry/Prometheus configuration
docs/architecture        Diagrams and architecture decisions
```

The UI component source stays in `apps/web` until a second frontend needs it. Creating a shared UI package now would introduce versioning and ownership overhead without a consumer.

## 3. Database changes

Create only the platform kernel:

- `users`
- `organizations`
- `organization_memberships`
- `audit_logs`
- `outbox_events`

Business IDs are UUIDs supplied by application services so the ID strategy can use time-ordered UUIDv7 without database-specific extensions. JSONB is limited to immutable audit metadata and event payloads, where schemas vary by event version and normalization would not improve querying.

## 4. APIs

- `GET /health/live`: process liveness only
- `GET /health/ready`: PostgreSQL and Redis readiness
- `GET /metrics`: Prometheus exposition
- `GET /openapi.json`: machine-readable control-plane contract
- `GET /v1/system`: service/version information
- AI equivalents for health, metrics, and OpenAPI

No public business endpoint is introduced in this milestone.

## 5. Frontend pages

No product page is implemented. `/` redirects to the web runtime health route. Dashboard design begins with a complete visual concept in Milestone 1; a framework starter screen will not become accidental product design.

## 6. Backend implementation

- Fastify-based NestJS bootstrap
- Strict environment validation
- Request validation and secure headers
- CORS allowlist
- Structured Pino logging with sensitive-field redaction
- OpenAPI generation
- PostgreSQL and Redis lifecycle adapters
- Liveness, readiness, and Prometheus metrics

Domain modules are added only with their corresponding vertical slice.

## 7. AI service

- Python 3.12 and uv lockfile
- FastAPI application factory
- Pydantic settings with production validation
- Structured JSON logging and correlation IDs
- OpenTelemetry initialization hook
- Health, readiness, metrics, and OpenAPI contracts

Model dependencies such as PyTorch, Whisper, and Pyannote are intentionally deferred to avoid large, unused base images and incompatible lock pressure.

## 8. Tests

- Unit tests for environment validation and health behavior
- HTTP contract tests for web, API, and AI health routes
- Prisma schema validation
- Compose configuration validation
- CI jobs for lint, strict type checking, tests, and builds

Integration tests that require PostgreSQL and Redis are introduced with the first persistence workflow.

## 9. Docker updates

- Local Compose dependencies with health checks and named volumes
- Non-root, multi-stage runtime images for web, API, and AI services
- `.dockerignore` files to keep secrets, caches, and local environments out of build contexts

Local image tags are configurable. Production deployments must pin resolved image digests through the deployment configuration.

## 10. Deployment

Kubernetes manifests are not emitted before resource profiles and runtime contracts exist. This milestone defines container ports, health endpoints, graceful shutdown, environment contracts, and stateless service boundaries—the inputs required for a useful Helm chart in Milestone 1.

## 11. Risks

- Python ML packages may force narrower Python/CUDA compatibility later; Python 3.12 minimizes current ecosystem risk.
- BullMQ can become awkward for complex long-lived DAGs; the queue is abstracted and PostgreSQL retains workflow authority.
- A monorepo can make CI slow; task-graph caching and path-aware jobs constrain the cost.
- Early observability can collect sensitive dialogue if logging discipline slips; transcript/media content is prohibited from logs.

## 12. Improvements after this milestone

- Add organization-aware authentication and rotating refresh sessions.
- Implement resumable S3 multipart upload and quarantine.
- Add the durable job/stage/attempt state machine and outbox relay.
- Generate the approved dashboard design and implement the first secure upload vertical slice.
- Add signed CI provenance, SBOM generation, container vulnerability scanning, and digest-pinned deployment images.
