# ADR 0007: Vercel and Supabase cloud boundaries

- Status: Accepted
- Date: 2026-07-16

## Context

VoiceVerse needs managed frontend delivery and managed PostgreSQL before the dubbing
workflow expands. Vercel is optimized for Next.js delivery and preview environments.
Supabase provides managed PostgreSQL, connection pooling, backups, and database
observability. Neither choice should collapse the existing control-plane, compute-plane,
or restricted-media security boundaries.

The NestJS API needs durable connections, strict origin-aware cookie mutation, and future
WebSocket delivery. The BullMQ relay, malware scanner, rendering workers, and AI workers
are long-running processes. Feature-length source media must continue to use direct
multipart object-storage transfer rather than pass through a frontend function.

## Decision

Deploy only `apps/web` to Vercel. The NestJS API, Node worker, Redis, ClamAV, and Python
compute plane remain container workloads and will be deployed to a separate runtime.
Production uses a custom same-site web/API domain pair such as `app.voiceverse.ai` and
`api.voiceverse.ai`.

Use Supabase as private managed PostgreSQL. VoiceVerse does not use Supabase Auth,
Storage, Realtime, or the browser Data API in this phase. Disable the Data API and revoke
its `anon`, `authenticated`, and `service_role` grants from application tables. All
browser business operations continue through NestJS authorization and audit boundaries.

Use separate database credentials and URLs:

- `DATABASE_URL` is the least-privilege runtime connection used by API and worker pools.
- `DIRECT_URL` is the migration connection used only by Prisma CLI in a protected
  deployment environment.
- Persistent IPv6-capable containers use the direct endpoint. IPv4-only persistent
  containers and hosted migration runners use Supavisor session mode on port 5432.
- Transaction mode on port 6543 is reserved for future short-lived/serverless database
  clients and is not used for migrations or the current NestJS runtime.

Vercel deployment is Git-based with `apps/web` as the project root. Preview and
production environments receive an explicit `NEXT_PUBLIC_API_BASE_URL`; database and
backend secrets are never configured in the Vercel web project.

## Consequences

- Frontend previews and rollbacks are independent of API/worker deployment.
- Supabase reduces database operations work without making it a second application
  backend.
- A separate container platform is still required before a public end-to-end deployment.
- Cross-environment authentication needs an exact allowed web origin and an
  environment-matched API; arbitrary preview domains are not trusted automatically.
- Connection budgets must include every API and worker replica. Pool sizes are bounded
  and monitored instead of scaling with request concurrency.
- Database changes use forward-only expand/contract migrations. Vercel rollback cannot
  reverse an incompatible database migration.
