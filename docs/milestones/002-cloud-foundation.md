# Milestone 2: Vercel and Supabase cloud foundation

Status: **Repository preparation complete; account provisioning pending — July 16, 2026**

## 1. Goal

Make the existing web and database tiers deployable to Vercel and Supabase without moving
the NestJS control plane, long-running workers, identity policy, or restricted media into
an unsuitable serverless boundary.

## 2. Folder structure

```text
apps/web/vercel.json                         Vercel framework contract
docs/architecture/adr/0007-*                 cloud ownership decision
docs/deployment/vercel-supabase.md           operator runbook
infrastructure/supabase                      security verification SQL
packages/database/prisma.config.ts           migration connection selection
packages/database/prisma/migrations/*        portable Data API grant hardening
.github/workflows/deploy-database.yaml       protected forward migration workflow
```

## 3. Database changes

Prisma CLI uses `DIRECT_URL`, while API and worker processes continue to use
`DATABASE_URL`. Pool size, connection timeout, idle timeout, idle-in-transaction timeout,
and statement timeout are explicit and bounded. A portable migration revokes Supabase
Data API roles from VoiceVerse tables and future migration-owned tables.

## 4. APIs

No public endpoint changes. Deployed APIs must set exact web origins and secure cookie
configuration for their corresponding Vercel environment.

## 5. Frontend pages

No page changes. Vercel builds the existing Next.js application from `apps/web` and
receives only the public API base URL.

## 6. Backend implementation

The database adapter now applies resource timeouts in addition to its bounded pool and
UTC session contract. NestJS and workers remain container workloads; Vercel does not own
business APIs or background execution.

## 7. AI service

No changes. FastAPI and future CPU/GPU workers remain outside Vercel and Supabase.

## 8. Tests

Validate environment limits, Prisma schema and migration deployment, fresh PostgreSQL
compatibility, deterministic browser behavior, production builds, Compose configuration,
and the Supabase role-grant audit query.

## 9. Docker updates

Compose propagates database pool and timeout settings so local/container behavior matches
the hosted runtime contract. No Supabase services are duplicated locally.

## 10. Deployment

Use Vercel Git integration for web previews and production. Use protected GitHub
environments for explicit forward-only Prisma migration deployment. Supabase credentials
remain outside Vercel. A container platform for API, worker, Redis, scanner, and AI is the
next infrastructure decision.

## 11. Risks

- Vercel preview domains need exact environment-matched API origins for cookie mutation.
- A migration can outlive a Vercel rollback; all schema changes must use expand/contract.
- Pool exhaustion is possible if replica count and per-process pools are scaled
  independently.
- Account provisioning, billing tier, region, backups, and domain configuration require
  operator-owned Vercel, Supabase, Google, DNS, and secrets-manager access.

## 12. Improvements

- Select the managed container/Kubernetes runtime and managed Redis provider.
- Add staging and production smoke workflows after account credentials exist.
- Add database-level tenant RLS once every Prisma transaction propagates a verified
  organization context through a least-privilege runtime role.
- Add automated backup-restore and point-in-time recovery drills.
