# VoiceVerse AI

> Dub any video into any language while preserving every character's unique voice, emotion, and identity.

VoiceVerse AI is a production-oriented multilingual dubbing platform. This repository contains the web application, NestJS control plane, Python AI execution plane, shared database package, infrastructure definitions, and architecture documentation.

**Milestone 1: Tenant identity and secure media ingest** is implemented. The current
vertical slice includes Supabase-managed Google identity, NestJS-enforced organization
authorization, projects, direct resumable multipart upload, quarantine, and asynchronous
malware scanning. **Milestone 2: Vercel and Supabase cloud foundation** is
repository-ready; cloud account provisioning remains an operator step. **Milestone 3:
Supabase authentication** connects browser sessions to the existing VoiceVerse identity
and tenancy model without exposing the database through the Supabase Data API.
**Milestone 4: Durable workflow and source-media preparation** adds PostgreSQL-backed
job/stage/attempt state, recoverable BullMQ delivery, authenticated FFprobe/FFmpeg
execution, immutable audio derivatives, and authoritative progress in the studio. Its
repository implementation is complete; managed-database migration and production
workload activation remain operator-controlled deployment steps. **Milestone 5: Speech
analysis and character identification** adds the disabled-by-default durable DAG,
provider-neutral execution contracts, normalized transcript/speaker/character memory,
and read-only job results. Production separation, ASR, and diarization remain gated on
pinned real-provider GPU images/models, licensed cross-language golden contracts,
feature-film manifest/memory/transaction validation, quota-bounded ephemeral scratch,
private deployment/observability approval, and license/legal review; translation, TTS,
lip sync, and dubbed export were outside that milestone.

The M5 control plane now creates speech consumers only after all exact capability/model
readiness handshakes pass and repeats the relevant handshake before every remote lease
claim. Trusted pre-provider HTTP 429 capacity signals use bounded same-attempt deferral;
expired running leases time out into a new attempt/output namespace, and proven heartbeat
lease loss aborts the executor request. Artifact provenance, stem formats, bounded
streamed manifests, aggregate-free active polling, and deterministic character ordering
are covered by repository contracts and tests.

**Milestone 6: Scene-aware contextual translation** adds versioned scenes,
source/target dialogue revisions, terminology and cultural context, provider-neutral
LLM execution, editable translation APIs/UI, review state, undo history, and immutable
generation provenance. Its repository implementation is complete and disabled by
default; production generation remains gated on an explicitly configured and approved
real provider/model. TTS, voice cloning, emotion synthesis, lip sync, final mixing, and
dubbed export remain out of scope. See the
[milestone contract](docs/milestones/006-scene-aware-contextual-translation.md) and
[ADR-0011](docs/architecture/adr/0011-nest-owned-localization-and-provider-neutral-translation.md).

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
  docker/              Local development stack and MinIO origin policy
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

Google sign-in is configured in the Supabase dashboard. Copy the project URL and
publishable key into the public Supabase variables in `.env`; point the API at the same
project's JWKS endpoint. Google client credentials remain in Supabase and must never be
placed in this repository or the Vercel web project. See the deployment guide for the
required callback and redirect URLs.

If a default dependency port is already in use, override `POSTGRES_PORT`,
`REDIS_PORT`, or the MinIO ports in `.env` and update the matching host URL.
Container-to-container ports remain unchanged.

Community MinIO applies CORS at the server level. Keep
`MINIO_API_CORS_ALLOW_ORIGIN` restricted to the exact local web origins; managed
production S3 should use a bucket-level CORS policy instead.

Local endpoints after all services are running:

- Web health: `http://localhost:3000/api/health`
- Control-plane liveness: `http://localhost:3001/health/live`
- Control-plane readiness: `http://localhost:3001/health/ready`
- Control-plane OpenAPI: `http://localhost:3001/openapi.json`
- Worker liveness inside the Compose network: `http://worker:3002/health/live`
- Worker readiness inside the Compose network: `http://worker:3002/health/ready`
- AI liveness: `http://localhost:8000/health/live`
- AI readiness: `http://localhost:8000/health/ready`

Stock Compose keeps speech analysis disabled and does not inject a separation, ASR, or
diarization provider. Deterministic providers are test-only; real speech processing needs
separately approved capability images or adapters. Production worker configuration also
requires HTTPS for media executors and for every speech executor when M5 is enabled.
The local named scratch volume is not a production storage quota, and the current bounded
manifest stream still materializes its capped JSON body for strict validation; both need
representative long-film and Kubernetes quota/eviction validation before activation.

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

The production web/database deployment contract is documented in
[`docs/deployment/vercel-supabase.md`](docs/deployment/vercel-supabase.md). Vercel hosts
the web tier; Supabase supplies Auth and private managed PostgreSQL while the Data API
remains disabled. The API and workers remain container workloads.
