# VoiceVerse AI

> Dub any video into any language while preserving every character's unique voice, emotion, and identity.

VoiceVerse AI is a production-oriented multilingual dubbing platform. This repository contains the web application, NestJS control plane, Python AI execution plane, shared database package, infrastructure definitions, and architecture documentation.

**Milestone 1: Tenant identity and secure media ingest** is implemented. The current
vertical slice includes Google OIDC, organization-scoped sessions, projects, direct
resumable multipart upload, quarantine, and asynchronous malware scanning. AI pipeline
stages begin after the clean-media gate in Milestone 2.

## Repository map

```text
apps/
  api/                 NestJS business control plane
  web/                 Next.js web application
packages/
  database/            Prisma schema and database client factory
services/
  ai/                  FastAPI AI execution plane
infrastructure/
  clamav/              Malware scanner image
  docker/              Local development stack
  minio/               Private bucket CORS policy
  observability/       Collector and monitoring configuration
docs/
  architecture/        System design and ADRs
  milestones/          Incremental delivery plans and acceptance criteria
```

## Prerequisites

- Node.js 22.16 or newer within the supported Node 22/24 range
- pnpm 10.24
- Python 3.12
- uv
- Docker Desktop with Compose v2

## Local bootstrap

```bash
cp .env.example .env
pnpm install --frozen-lockfile
uv sync --project services/ai --all-groups
pnpm db:generate
pnpm infra:up
pnpm db:migrate:deploy
pnpm dev
```

Run the media-security worker in a second terminal:

```bash
pnpm --filter @voiceverse/api dev:worker
```

Google sign-in requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The local API can
still start without them so that health, schema, project, and test workflows remain
available. Never use development-generated JWT material outside local development.

If a default dependency port is already in use, override `POSTGRES_PORT`,
`REDIS_PORT`, or the MinIO ports in `.env` and update the matching host URL.
Container-to-container ports remain unchanged.

Local endpoints after all services are running:

- Web health: `http://localhost:3000/api/health`
- Control-plane liveness: `http://localhost:3001/health/live`
- Control-plane readiness: `http://localhost:3001/health/ready`
- Control-plane OpenAPI: `http://localhost:3001/openapi.json`
- Worker liveness inside the Compose network: `http://worker:3002/health/live`
- AI liveness: `http://localhost:8000/health/live`
- AI readiness: `http://localhost:8000/health/ready`

The official ClamAV container is pinned to `linux/amd64`. Docker Desktop uses emulation
on Apple Silicon; production Kubernetes scanner pods should target an amd64 node pool.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @voiceverse/web exec playwright install chromium
pnpm --filter @voiceverse/web test:e2e
```

Architecture decisions live in [`docs/architecture/adr`](docs/architecture/adr). Do not bypass those boundaries without replacing the relevant ADR.
